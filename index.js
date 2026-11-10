
require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = "/telegram-webhook";

const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
const webhookUrl = `https://${hostname}${WEBHOOK_PATH}`;

// Middleware
app.use(express.json());

// Start command
bot.start((ctx) => {
    ctx.reply("Welcome! I am your FutureWise Telegram bot 🚀");
});

// Help command
bot.help((ctx) => {
    ctx.reply("Available commands:\n/start\n/help\n/about");
});

// About command
bot.command("about", (ctx) => {
    ctx.reply("I am built using Node.js and Telegraf.js!");
});

// Normal text messages
bot.hears("Hello", (ctx) => {
    ctx.reply("Hey! Welcome to FutureWise!");
});

// Handle all Telegram webhook updates
app.use(
    bot.webhookCallback(WEBHOOK_PATH, {
        secretToken: process.env.WEBHOOK_SECRET
    })
);

// Health check
app.get("/", (req, res) => {
    res.send("FutureWise Telegram Bot is running!");
});

// Start Express server
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

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
