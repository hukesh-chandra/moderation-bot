// Production entry point (index.js)
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  // Gemini Logic here...
  console.log("Analyzing:", message.content);
});

client.login(process.env.DISCORD_TOKEN);