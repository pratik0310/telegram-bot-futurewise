require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");
const Parser = require("rss-parser");

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const parser = new Parser();

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram-webhook";

const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
const webhookUrl = `https://${hostname}${WEBHOOK_PATH}`;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";

app.use(express.json());

// ============================================================
// HELPERS
// ============================================================

// Remove emoji + markdown symbols so reply is clean plain text
function cleanText(text) {
    return text
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
        .replace(/\*\*/g, "")
        .replace(/^#+\s*/gm, "")
        .replace(/[ \t]+$/gm, "")
        .trim();
}

// Telegram max message = 4096 chars
async function sendLong(ctx, text) {
    const MAX = 4000;
    for (let i = 0; i < text.length; i += MAX) {
        await ctx.reply(text.slice(i, i + MAX));
    }
}

// ============================================================
// NEWS FETCHING
// ============================================================

async function getIndiaNews(stock, days = 7) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const url =
        `https://news.google.com/rss/search?` +
        `q=${encodeURIComponent(stock + " stock India")}` +
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
        return articles.slice(0, 5);
    } catch (err) {
        console.error("News fetch failed:", err.message);
        return [];
    }
}

// ============================================================
// GEMINI ANALYSIS
// ============================================================

const SYSTEM_PROMPT = `You are a financial analyst. Analyze the recent news about the company and provide your response strictly using the format below. Do not add stray headers or break formatting. Do not use emoji. Do not use markdown symbols like ** or #.

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

async function runGemini(stock, articles) {
    const newsText = articles
        .map(
            (a, i) =>
                `Article ${i + 1}\n\nTitle:\n${a.title}\n\nSource:\n${a.source}\n\nDate:\n${a.posted}\n`
        )
        .join("\n");

    const userPrompt = `Company / Stock:\n${stock}\n\nRecent News:\n${newsText}`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 1024
                }
            })
        }
    );

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Gemini ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("");

    if (!text) throw new Error("Gemini returned empty response");

    return cleanText(text);
}

// ============================================================
// COMMANDS
// ============================================================

bot.start((ctx) => {
    ctx.reply(
        "Welcome I am your FutureWise Telegram bot. This is created by Ashwin, Sarthak, Pratik, Yash.\n\n" +
            "Send any stock name (example: Reliance, TCS, HDFC Bank) and I will analyze recent news."
    );
});

bot.help((ctx) => {
    ctx.reply(
        "Available commands:\n/start\n/help\n/about\n\n" +
            "Or just type a stock name to get news analysis."
    );
});

bot.command("about", (ctx) => {
    ctx.reply("I am built using Node.js, Telegraf.js and Gemini API.");
});

bot.hears(/^hello$/i, (ctx) => {
    ctx.reply("Hey! Welcome to FutureWise!");
});

// ============================================================
// STOCK NAME HANDLER (any other text)
// ============================================================

bot.on("text", async (ctx) => {
    const stock = ctx.message.text.trim();

    // ignore unknown slash commands
    if (stock.startsWith("/")) return;

    if (stock.length > 60) {
        return ctx.reply("Stock name too long. Send a short name like Reliance or TCS.");
    }

    await ctx.reply(`Analyzing ${stock}. Please wait...`);

    try {
        const articles = await getIndiaNews(stock, 7);

        if (articles.length === 0) {
            return ctx.reply(
                `No relevant recent news found for ${stock} in last 7 days. Check the name and try again.`
            );
        }

        const analysis = await runGemini(stock, articles);

        const newsList = articles
            .map((a, i) => `${i + 1}. ${a.title}\n   ${a.posted}\n   ${a.link}`)
            .join("\n\n");

        const reply =
            `Stock: ${stock}\n\n` +
            `${analysis}\n\n` +
            `Recent News:\n${newsList}`;

        await sendLong(ctx, reply);
    } catch (err) {
        console.error("Analysis error:", err);
        await ctx.reply("Analysis failed. Please try again in a moment.");
    }
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