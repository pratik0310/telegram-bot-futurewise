require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");
const Parser = require("rss-parser");

const app = express();

// handlerTimeout off: analysis take longer than 90s default
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: Infinity });
const parser = new Parser();

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram-webhook";

const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
const webhookUrl = `https://${hostname}${WEBHOOK_PATH}`;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";
const MAX_PEERS = 3;

app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// MULTI API KEY POOL (size-aware load balancing)
// ============================================================
// Env: GEMINI_API_KEYS=key1,key2,key3   (or single GEMINI_API_KEY)
// Each key tracked over last 60s: request count + estimated tokens.
// Big request goes to key with most free token room.
// Key hit limit -> skipped. Key error 429 -> cooldown, retry on next key.

const KEY_RPM_LIMIT = Number(process.env.KEY_RPM_LIMIT) || 10; // req/min per key
const KEY_TPM_LIMIT = Number(process.env.KEY_TPM_LIMIT) || 200000; // tokens/min per key

class KeyPool {
    constructor(keys) {
        this.keys = keys.map((key) => ({ key, hits: [], cooldownUntil: 0 }));
    }

    get size() {
        return this.keys.length;
    }

    async acquire(tokens, maxWaitMs = 90000) {
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
            const now = Date.now();
            let best = null;
            let soonest = now + 2000;

            for (const k of this.keys) {
                k.hits = k.hits.filter((h) => now - h.t < 60000);

                if (k.cooldownUntil > now) {
                    soonest = Math.min(soonest, k.cooldownUntil);
                    continue;
                }

                const reqs = k.hits.length;
                const used = k.hits.reduce((s, h) => s + h.tokens, 0);

                // full: wait. (empty key always allowed, even if request huge)
                if (reqs >= KEY_RPM_LIMIT || (used > 0 && used + tokens > KEY_TPM_LIMIT)) {
                    if (k.hits[0]) soonest = Math.min(soonest, k.hits[0].t + 60000);
                    continue;
                }

                if (!best || used < best.used) best = { k, used };
            }

            if (best) {
                best.k.hits.push({ t: now, tokens });
                return best.k;
            }

            await sleep(Math.max(500, Math.min(soonest - now, 5000)));
        }

        throw new Error("All API keys busy. Try again soon.");
    }
}

const rawKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

if (rawKeys.length === 0) {
    console.error("No Gemini key. Set GEMINI_API_KEYS=key1,key2 in env.");
}

const pool = new KeyPool([...new Set(rawKeys)]);
console.log(`Gemini keys loaded: ${pool.size}`);

async function callGemini(system, user, { json = false, maxOutputTokens = 1024 } = {}) {
    // rough size estimate: 4 chars ~ 1 token, plus output budget
    const tokens = Math.ceil((system.length + user.length) / 4) + maxOutputTokens;
    const maxAttempts = Math.max(3, pool.size + 2);
    let lastErr;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const k = await pool.acquire(tokens);

        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": k.key
                    },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: system }] },
                        contents: [{ role: "user", parts: [{ text: user }] }],
                        generationConfig: {
                            temperature: 0.2,
                            maxOutputTokens,
                            ...(json ? { responseMimeType: "application/json" } : {})
                        }
                    })
                }
            );

            if (!res.ok) {
                const body = await res.text();
                const tail = k.key.slice(-4);

                if (res.status === 429) {
                    k.cooldownUntil = Date.now() + 30000;
                } else if (res.status === 400 || res.status === 401 || res.status === 403) {
                    // bad / blocked key (or bad request): bench key 10 min
                    k.cooldownUntil = Date.now() + 10 * 60000;
                } else {
                    k.cooldownUntil = Date.now() + 5000;
                }

                console.error(`Gemini key ...${tail} status ${res.status}: ${body.slice(0, 200)}`);
                lastErr = new Error(`Gemini ${res.status}`);
                continue; // retry on next key
            }

            const data = await res.json();
            const text = (data.candidates?.[0]?.content?.parts || [])
                .map((p) => p.text || "")
                .join("");

            if (!text) {
                lastErr = new Error("Gemini empty response");
                continue;
            }

            return text;
        } catch (err) {
            k.cooldownUntil = Date.now() + 5000;
            lastErr = err;
        }
    }

    throw lastErr || new Error("Gemini failed");
}

function parseJSON(text) {
    const cleaned = text.replace(/```json|```/g, "").trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        throw new Error("Bad JSON from Gemini");
    }
}

// ============================================================
// HELPERS
// ============================================================

// Strip emoji + markdown symbols so reply is clean plain text
function cleanText(text) {
    return String(text)
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
        .replace(/\*\*/g, "")
        .replace(/^#+\s*/gm, "")
        .replace(/[ \t]+$/gm, "")
        .trim();
}

// Telegram max message = 4096 chars
async function sendLong(ctx, text) {
    const clean = cleanText(text);
    const MAX = 4000;
    for (let i = 0; i < clean.length; i += MAX) {
        await ctx.reply(clean.slice(i, i + MAX), { disable_web_page_preview: true });
    }
}

const list = (arr) => (Array.isArray(arr) && arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- None");

// ============================================================
// NEWS FETCHING
// ============================================================

async function getIndiaNews(query, days = 7, limit = 10) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const url =
        `https://news.google.com/rss/search?` +
        `q=${encodeURIComponent(query + " stock India")}` +
        `&hl=en-IN&gl=IN&ceid=IN:en`;

    try {
        const feed = await parser.parseURL(url);
        const seen = new Set();
        const articles = [];

        for (const item of feed.items) {
            const title = (item.title || "").trim();
            if (!title) continue;

            const published = new Date(item.isoDate || item.pubDate || 0);
            if (isNaN(published) || published.getTime() < cutoff) continue;

            const key = title.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            articles.push({
                title,
                link: item.link || "",
                source: "Google News India",
                posted: published.toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                }),
                time: published.getTime()
            });
        }

        articles.sort((a, b) => b.time - a.time);
        return articles.slice(0, limit);
    } catch (err) {
        console.error("News fetch failed:", query, err.message);
        return [];
    }
}

function formatNews(stock, articles) {
    const lines = articles
        .map((a, i) => `${i + 1}. ${a.title}\n   ${a.posted}\n   ${a.link}`)
        .join("\n\n");
    return `Latest news for ${stock} (last 7 days):\n\n${lines}`;
}

// ============================================================
// AI: MAIN STOCK ANALYSIS (FinGPT style format)
// ============================================================

const ANALYST_PROMPT = `You are a financial analyst. Analyze the recent news about the company and provide your response strictly using the format below. Do not add stray headers or break formatting. Do not use emoji. Do not use markdown symbols like ** or #.

[Positive Developments]:
- (Point 1)
- (Point 2)

[Potential Concerns]:
- (Point 1)
- (Point 2)

[Analysis]:
(Brief explanation)

[Overall Impact]:
(Choose only one exact word: Bullish / Bearish / Neutral)

Important:
Do not invent facts.
Base the analysis only on the provided news.
All fields are compulsory. Do not miss any field.
Say Bearish when negative news is more than positive news.
Say Bullish when positive news is more than negative news.
Say Neutral when balanced.`;

async function runAnalysis(stock, articles) {
    const newsText = articles
        .slice(0, 5)
        .map((a, i) => `Article ${i + 1}\nTitle: ${a.title}\nSource: ${a.source}\nDate: ${a.posted}\n`)
        .join("\n");

    const text = await callGemini(
        ANALYST_PROMPT,
        `Company / Stock:\n${stock}\n\nRecent News:\n${newsText}`,
        { maxOutputTokens: 1024 }
    );
    return cleanText(text);
}

// ============================================================
// AI: INDUSTRY + PEERS
// ============================================================

async function identifyPeers(stock) {
    const system = `You are an Indian stock market expert. Return ONLY a valid JSON object. No emoji.`;
    const user = `For the Indian stock "${stock}" (NSE/BSE), identify:
1. The industry sector it belongs to
2. Top ${MAX_PEERS} closely related stocks in the SAME industry (competitors/peers)
3. Brief explanation why these are related

Return exactly:
{
  "symbol": "NSE symbol of the given stock",
  "industry": "Industry Name",
  "peers": ["PEER1", "PEER2", "PEER3"],
  "explanation": "Brief explanation"
}

Use NSE symbols (example: RELIANCE, TCS, HDFCBANK). Do not include the given stock in peers.`;

    const data = parseJSON(await callGemini(system, user, { json: true, maxOutputTokens: 512 }));

    const main = String(data.symbol || stock).toUpperCase();
    const peers = [...new Set((data.peers || []).map((p) => String(p).toUpperCase()))]
        .filter((p) => p !== main && p !== stock.toUpperCase())
        .slice(0, MAX_PEERS);

    return {
        symbol: main,
        industry: data.industry || "Unknown",
        peers,
        explanation: data.explanation || ""
    };
}

// ============================================================
// AI: SENTIMENT PER STOCK
// ============================================================

async function analyzeSentiment(symbol, articles) {
    if (!articles.length) {
        return {
            score: 0,
            sentiment: "neutral",
            confidence: "low",
            key_points: ["No recent news"],
            summary: `No recent news found for ${symbol}.`
        };
    }

    const headlines = articles
        .slice(0, 10)
        .map((a, i) => `${i + 1}. ${a.title}`)
        .join("\n");

    const system = `You are a financial news sentiment analyst. Return ONLY valid JSON. No emoji.`;
    const user = `Analyze sentiment for ${symbol} based on these news headlines:

${headlines}

Return exactly:
{
  "score": 0.0,
  "sentiment": "positive|neutral|negative",
  "confidence": "high|medium|low",
  "key_points": ["point1", "point2", "point3"],
  "summary": "1-2 sentence summary"
}

Rules: score from -1.0 to 1.0. Max 3 key points. Use only the headlines given.`;

    try {
        const d = parseJSON(await callGemini(system, user, { json: true, maxOutputTokens: 512 }));
        return {
            score: Number(d.score) || 0,
            sentiment: d.sentiment || "neutral",
            confidence: d.confidence || "low",
            key_points: Array.isArray(d.key_points) ? d.key_points.slice(0, 3) : [],
            summary: d.summary || ""
        };
    } catch (err) {
        console.error("Sentiment failed:", symbol, err.message);
        return {
            score: 0,
            sentiment: "neutral",
            confidence: "low",
            key_points: ["Analysis failed"],
            summary: "Could not analyze sentiment."
        };
    }
}

// ============================================================
// AI: COMPARE + BEST INVESTMENT
// ============================================================

async function compareStocks(stockData, industry) {
    const block = Object.entries(stockData)
        .map(
            ([sym, d]) =>
                `Stock: ${sym}\nSentiment Score: ${d.sentiment.score.toFixed(2)}\nSentiment: ${d.sentiment.sentiment}\nConfidence: ${d.sentiment.confidence}\nKey Points: ${d.sentiment.key_points.join("; ")}\nSummary: ${d.sentiment.summary}\nNews Count: ${d.news.length}`
        )
        .join("\n---\n");

    const system = `You are a financial analyst. Return ONLY valid JSON. No emoji. Base everything only on the data given. Do not invent facts.`;
    const user = `Compare these stocks in the ${industry} industry based on recent news sentiment:

${block}

Provide ranking best to worst, industry summary, strengths of top stocks, weaknesses of bottom stocks, and which single stock is the better investment in the current situation, with proper reason.

Return exactly:
{
  "ranking": [{"rank": 1, "symbol": "STOCK1", "score": 0.0, "recommendation": "Buy/Hold/Sell"}],
  "industry_summary": "Overall industry sentiment",
  "top_strengths": ["strength1", "strength2"],
  "bottom_weaknesses": ["weakness1", "weakness2"],
  "best_pick": "SYMBOL",
  "best_pick_reason": "Proper reason",
  "overall_recommendation": "Overall recommendation"
}`;

    try {
        return parseJSON(await callGemini(system, user, { json: true, maxOutputTokens: 1024 }));
    } catch (err) {
        console.error("Compare failed:", err.message);
        const ranking = Object.entries(stockData)
            .sort((a, b) => b[1].sentiment.score - a[1].sentiment.score)
            .map(([symbol, d], i) => ({
                rank: i + 1,
                symbol,
                score: d.sentiment.score,
                recommendation: "Hold"
            }));
        return {
            ranking,
            industry_summary: "Full comparison unavailable. Ranked by sentiment score only.",
            top_strengths: [],
            bottom_weaknesses: [],
            best_pick: ranking[0]?.symbol || "",
            best_pick_reason: "Highest news sentiment score.",
            overall_recommendation: "Review each stock individually."
        };
    }
}

function formatComparison(info, comparison, stockData) {
    const ranking = (comparison.ranking || [])
        .map(
            (r) =>
                `${r.rank}. ${r.symbol} - score ${Number(r.score).toFixed(2)} - ${r.recommendation || "Hold"}`
        )
        .join("\n");

    const details = Object.entries(stockData)
        .map(
            ([sym, d]) =>
                `${sym}: ${d.sentiment.sentiment} (${d.sentiment.confidence} confidence, ${d.news.length} articles)\n${d.sentiment.summary}`
        )
        .join("\n\n");

    return (
        `Industry: ${info.industry}\n` +
        `Compared: ${Object.keys(stockData).join(", ")}\n` +
        (info.explanation ? `${info.explanation}\n` : "") +
        `\nRanking by news sentiment:\n${ranking}\n\n` +
        `Industry Summary:\n${comparison.industry_summary || "N/A"}\n\n` +
        `Strengths of top stocks:\n${list(comparison.top_strengths)}\n\n` +
        `Weaknesses of bottom stocks:\n${list(comparison.bottom_weaknesses)}\n\n` +
        `Better investment now: ${comparison.best_pick || "N/A"}\n` +
        `Reason: ${comparison.best_pick_reason || "N/A"}\n\n` +
        `Overall:\n${comparison.overall_recommendation || "N/A"}\n\n` +
        `Details:\n${details}\n\n` +
        `Based on news sentiment only. Not financial advice.`
    );
}

// ============================================================
// MAIN FLOW
// ============================================================

async function handleStock(ctx, stock) {
    try {
        // STEP 1: news first, send right away
        const news = await getIndiaNews(stock, 7, 10);

        if (news.length === 0) {
            return ctx.reply(
                `No relevant recent news found for ${stock} in last 7 days. Check the name and try again.`
            );
        }

        await sendLong(ctx, formatNews(stock, news.slice(0, 5)));
        await ctx.reply("AI analysis running. Results coming in parts...");

        // STEP 2: start peer lookup in background while main analysis runs
        const peersPromise = identifyPeers(stock).catch((e) => {
            console.error("Peers failed:", e.message);
            return null;
        });

        // STEP 3: main stock analysis -> send as soon as ready
        try {
            const analysis = await runAnalysis(stock, news);
            await sendLong(ctx, `Analysis: ${stock}\n\n${analysis}`);
        } catch (err) {
            console.error("Main analysis failed:", err.message);
            await ctx.reply("Main analysis failed. Please try again in a moment.");
        }

        // STEP 4: peers + comparison
        const info = await peersPromise;
        if (!info || info.peers.length === 0) {
            return ctx.reply("Could not find peer stocks for comparison.");
        }

        await ctx.reply(`Industry: ${info.industry}\nComparing with: ${info.peers.join(", ")}...`);

        const symbols = [stock.toUpperCase(), ...info.peers];

        // all news fetch + sentiment calls run in parallel, pool spread across keys
        const entries = await Promise.all(
            symbols.map(async (sym, i) => {
                const articles = i === 0 ? news : await getIndiaNews(sym, 7, 10);
                const sentiment = await analyzeSentiment(sym, articles);
                return [sym, { news: articles, sentiment }];
            })
        );
        const stockData = Object.fromEntries(entries);

        const comparison = await compareStocks(stockData, info.industry);
        await sendLong(ctx, formatComparison(info, comparison, stockData));
    } catch (err) {
        console.error("Flow error:", err);
        await ctx.reply("Something failed. Please try again in a moment.").catch(() => {});
    }
}

// ============================================================
// COMMANDS
// ============================================================

bot.start((ctx) => {
    ctx.reply(
        "Welcome I am your FutureWise Telegram bot. This is created by Ashwin, Sarthak, Pratik, Yash.\n\n" +
            "Send any stock name (example: Reliance, TCS, HDFC Bank). I send latest news first, then AI analysis and peer comparison."
    );
});

bot.help((ctx) => {
    ctx.reply(
        "Available commands:\n/start\n/help\n/about\n\n" +
            "Or just type a stock name to get news and analysis."
    );
});

bot.command("about", (ctx) => {
    ctx.reply("I am built using Node.js, Telegraf.js and Gemini API.");
});

bot.hears(/^hello$/i, (ctx) => {
    ctx.reply("Hey! Welcome to FutureWise!");
});

bot.on("text", (ctx) => {
    const stock = ctx.message.text.trim();

    if (stock.startsWith("/")) return;

    if (stock.length > 60) {
        return ctx.reply("Stock name too long. Send a short name like Reliance or TCS.");
    }

    if (pool.size === 0) {
        return ctx.reply("Bot not configured: no Gemini API key set.");
    }

    ctx.reply(`Fetching news for ${stock}...`);

    // Run in background, do NOT await.
    // Webhook must return fast, else Telegram resend same update (duplicate replies).
    handleStock(ctx, stock);
});

bot.catch((err) => {
    console.error("Bot error:", err);
});

// ============================================================
// WEBHOOK + SERVER
// ============================================================

app.use(
    bot.webhookCallback(WEBHOOK_PATH, {
        secretToken: process.env.WEBHOOK_SECRET
    })
);

app.get("/", (req, res) => {
    res.send("FutureWise Telegram Bot is running!");
});

app.listen(PORT, "0.0.0.0", async () => {
    try {
        await bot.telegram.setWebhook(webhookUrl, {
            secret_token: process.env.WEBHOOK_SECRET
        });

        console.log("Webhook configured successfully!");
        console.log(`Server running on port ${PORT}`);
    } catch (error) {
        console.error("Webhook setup failed:", error);
        process.exit(1);
    }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));