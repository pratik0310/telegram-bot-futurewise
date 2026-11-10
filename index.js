require("dotenv").config();

const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// Start command
bot.start((ctx) => {
    ctx.reply("Welcome! I am your first Telegram bot 🚀");
});

// Help command
bot.help((ctx) => {
    ctx.reply("Available commands:\n/start\n/help\n/about");
});

// About command
bot.command("about", (ctx) => {
    ctx.reply("I am built using Node.js and Telegraf.js!");
});

// Launch bot
bot.launch();

console.log("Bot is running...");