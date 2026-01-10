
import http from 'http';

// --- 1. CLOUD RUN STABILITY & HEALTH ---
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TITAN CORE v25.0: HYPER-RESPONSE ACTIVE');
}).listen(PORT, () => console.log(`[BOOT] Stability Guard v25 active on ${PORT}`));

// Watchdog to detect event loop freezes
setInterval(() => {
    if (global.lastHeartbeat && Date.now() - global.lastHeartbeat > 30000) {
        console.error("[WATCHDOG] Event loop freeze detected!");
    }
    global.lastHeartbeat = Date.now();
}, 10000);

import { 
    Client, GatewayIntentBits, Events, EmbedBuilder, PermissionFlagsBits, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ChannelType 
} from 'discord.js';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// --- 2. DATABASE & SAFETY GUARDS ---
process.on('unhandledRejection', (r) => console.error('[FATAL REJECTION]:', r));
process.on('uncaughtException', (e) => console.error('[FATAL EXCEPTION]:', e));

let db;
try {
    if (!getApps().length) initializeApp({ credential: applicationDefault() });
    db = getFirestore();
} catch (e) { console.error("Firestore Error:", e); }

let activeHandlers = 0;
const MAX_CONCURRENT_HANDLERS = 60; 

const userCache = new Map();
const guildCache = new Map();
const xpBuffer = new Map(); // [userId]: xpAmount

// Helper for timing out slow DB requests
function withTimeout(promise, ms = 10000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
    ]);
}

// Internal Retry Logic: Silently retries DB calls to prevent "System Busy" errors
async function dbRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await withTimeout(fn()); } 
        catch (e) { if (i === retries - 1) throw e; await new Promise(r => setTimeout(r, 1000)); }
    }
}

// Flush XP Buffer to DB every 60 seconds (Optimization)
setInterval(async () => {
    if (xpBuffer.size === 0) return;
    const batch = db.batch();
    for (const [userId, xp] of xpBuffer.entries()) {
        const ref = db.collection('users').doc(userId);
        batch.set(ref, { xp: FieldValue.increment(xp) }, { merge: true });
    }
    try {
        await dbRetry(() => batch.commit());
        xpBuffer.clear();
    } catch (e) { console.error("[SYNC ERROR]", e); }
}, 60000);

// --- 3. CONFIGURATION & DATA ---
const PREFIX = ".a";
const STARTING_BAL = 1000;
const BASE_MAX_BET = 5000;
const DROPS_MIN_INTERVAL = 1500000; 
const DROPS_MSG_REQ = 200;

let globalMsgs = 0;
let lastDrop = Date.now();
const activeGames = new Set();
const cooldowns = new Map();
const snipes = new Map();

const ANIMALS = {
    "Common": [{n: "Rat", e: "🐀", v: 50}, {n: "Pigeon", e: "🐦", v: 50}],
    "Uncommon": [{n: "Fox", e: "🦊", v: 250}, {n: "Rabbit", e: "🐰", v: 250}],
    "Rare": [{n: "Panda", e: "🐼", v: 1000}, {n: "Tiger", e: "🐯", v: 1000}],
    "Epic": [{n: "Wolf", e: "🐺", v: 5000}, {n: "Dragon", e: "🐲", v: 10000}],
    "Legendary": [{n: "Phoenix", e: "🔥", v: 75000}, {n: "Kraken", e: "🔱", v: 150000}]
};

const SLOT_ICONS = ["🍒", "🍊", "🍋", "🍇", "🔔", "💎", "7️⃣"];

const SHOP_ITEMS = [
    { id: 'booster', name: 'XP Booster', price: 15000, desc: 'Increases XP gain permanently.' },
    { id: 'ring', name: 'Engagement Ring', price: 50000, desc: 'A gift for your favorite person.' },
    { id: 'crown', name: 'Titan Crown', price: 500000, desc: 'The ultimate symbol of wealth.' }
];

// --- 4. ENGINE HELPERS ---
async function getUser(id) {
    if (userCache.has(id)) return userCache.get(id);
    const ref = db.collection('users').doc(id);
    const doc = await dbRetry(() => ref.get());
    if (!doc.exists) {
        const d = { balance: STARTING_BAL, level: 1, xp: 0, gender: null, zoo: [], warns: [], items: [], lastDaily: 0, lastWork: 0, afk: null };
        await dbRetry(() => ref.set(d));
        userCache.set(id, d);
        return d;
    }
    const data = doc.data();
    userCache.set(id, data);
    return data;
}

async function getGuild(id) {
    if (guildCache.has(id)) return guildCache.get(id);
    const ref = db.collection('guilds').doc(id);
    const doc = await dbRetry(() => ref.get());
    if (!doc.exists) {
        const d = { bannedWords: [] };
        await dbRetry(() => ref.set(d));
        guildCache.set(id, d);
        return d;
    }
    const data = doc.data();
    guildCache.set(id, data);
    return data;
}

const getHonorific = (g) => g === 'boy' ? 'Daddy' : (g === 'girl' ? 'Mommy' : 'Citizen');

const getFlirt = (g, context = "generic") => {
    const h = getHonorific(g);
    const lines = {
        generic: [`Looking good, ${h}~`, `You're my favorite, ${h}.`, `Ready to dominate, ${h}?`],
        gamble: [`Feeling lucky for me, ${h}?`, `Show me those credits, ${h}~`, `Win big, I'm watching.`],
        lb: [`Checking who's on top, ${h}? It should be you.`, `You're always #1 in my heart, ${h}.`]
    };
    return lines[context]?.[Math.floor(Math.random() * lines[context].length)] || lines.generic[0];
};

const getXPNeeded = (lvl) => lvl * 1500;

function createDeck() {
    const s = ['♠️', '♥️', '♦️', '♣️'], v = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], d = [];
    for (const x of s) for (const y of v) d.push({ s: x, v: y });
    return d.sort(() => Math.random() - 0.5);
}

function getHandVal(h) {
    let val = 0, aces = 0;
    for (const c of h) { if (c.v === 'A') aces++; else if (['J', 'Q', 'K'].includes(c.v)) val += 10; else val += parseInt(c.v); }
    for (let i = 0; i < aces; i++) val += (val + 11 <= 21) ? 11 : 1;
    return val;
}

const formatHand = (h) => h.map(c => `\`[${c.v}${c.s}]\``).join(' ');

// --- 5. DISCORD CLIENT ---
const client = new Client({ intents: [32767] });

client.on(Events.MessageDelete, (m) => {
    if (m.partial || m.author?.bot) return;
    snipes.set(m.channel.id, { c: m.content, a: m.author, t: m.createdAt });
});

client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guild) return;

    const isCommand = msg.content.toLowerCase().startsWith(PREFIX);
    
    // Quick Cache Filter (No DB if cached)
    let currentGData = guildCache.get(msg.guild.id);
    if (!currentGData && !isCommand) return; // Ignore chat if guild isn't cached (prevents spam load)

    if (!currentGData) currentGData = await getGuild(msg.guild.id);

    if (currentGData.bannedWords?.some(w => msg.content.toLowerCase().includes(w.toLowerCase()))) {
        if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            msg.delete().catch(() => {});
            return;
        }
    }

    const xpGain = Math.floor(Math.random() * 11) + 5;
    xpBuffer.set(msg.author.id, (xpBuffer.get(msg.author.id) || 0) + xpGain);

    globalMsgs++;
    if (Date.now() - lastDrop > DROPS_MIN_INTERVAL && globalMsgs > DROPS_MSG_REQ) {
        lastDrop = Date.now(); globalMsgs = 0;
        const reward = Math.floor(Math.random() * 5000) + 1000;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('drop').setLabel('CLAIM').setStyle(ButtonStyle.Success));
        const dMsg = await msg.channel.send({ 
            embeds: [new EmbedBuilder().setTitle("📦 Supply Drop").setDescription("A supplies crate fell from the sky!").setColor(0xFEE75C)],
            components: [row]
        });
        dMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 20000 }).on('collect', async i => {
            await dbRetry(() => db.collection('users').doc(i.user.id).set({ balance: FieldValue.increment(reward) }, { merge: true }));
            userCache.delete(i.user.id);
            i.update({ content: `✅ **${i.user.username}** claimed the drop and found **${reward} credits**!`, embeds: [], components: [] });
        });
    }

    if (!isCommand) return;

    if (activeHandlers >= MAX_CONCURRENT_HANDLERS) return msg.reply("⚠️ System overloaded. Please wait 3s.");
    activeHandlers++;

    try {
        const uRef = db.collection('users').doc(msg.author.id);
        const data = await getUser(msg.author.id);

        const currentXP = (data.xp || 0) + (xpBuffer.get(msg.author.id) || 0);
        if (currentXP >= getXPNeeded(data.level)) {
            const newLvl = (data.level || 1) + 1;
            const reward = newLvl * 1000;
            await dbRetry(() => uRef.update({ balance: FieldValue.increment(reward), level: newLvl, xp: 0 }));
            xpBuffer.set(msg.author.id, 0);
            userCache.delete(msg.author.id);
            msg.reply(`🎊 **LEVEL UP!** Now **Level ${newLvl}**, ${getHonorific(data.gender)}!\n🎁 +${reward} credits!`);
        }

        if (data.afk) {
            await dbRetry(() => uRef.update({ afk: null }));
            userCache.delete(msg.author.id);
            msg.reply(`👋 Welcome back, **${getHonorific(data.gender)}**! AFK cleared.`);
        }

        const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
        const cmd = args.shift().toLowerCase();
        const lvl = data.level || 1;
        const maxBet = BASE_MAX_BET + (lvl * 5000);

        if (!data.gender && cmd !== 'help') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('boy').setLabel('Boy').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('girl').setLabel('Girl').setStyle(ButtonStyle.Danger)
            );
            const sMsg = await msg.reply({ embeds: [new EmbedBuilder().setTitle("🧬 Identity Lock").setDescription("Are you a boy or a girl?").setColor(0x5865F2)], components: [row] });
            sMsg.createMessageComponentCollector({ filter: i => i.user.id === msg.author.id, time: 30000 }).on('collect', async i => {
                await dbRetry(() => uRef.update({ gender: i.customId }));
                userCache.delete(msg.author.id);
                i.update({ content: `✅ Identity saved, **${getHonorific(i.customId)}**.`, embeds: [], components: [] });
            });
            activeHandlers--; return;
        }

        switch (cmd) {
            case 'ban':
                if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return;
                const bU = msg.mentions.members.first();
                if (!bU?.bannable) return msg.reply("❌ Invalid target.");
                await bU.ban({ reason: args.join(' ') || "No reason" });
                return msg.reply(`🔨 Banned ${bU.user.tag}.`);

            case 'kick':
                if (!msg.member.permissions.has(PermissionFlagsBits.KickMembers)) return;
                const kU = msg.mentions.members.first();
                if (!kU?.kickable) return msg.reply("❌ Invalid target.");
                await kU.kick(args.join(' ') || "No reason");
                return msg.reply(`👢 Kicked ${kU.user.tag}.`);

            case 'timeout':
                if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
                const tU = msg.mentions.members.first();
                const mins = parseInt(args[1]) || 10;
                if (!tU) return msg.reply("❌ Mention a user.");
                await tU.timeout(mins * 60000, args.slice(2).join(' ') || "No reason");
                return msg.reply(`🔇 Muted ${tU.user.tag} for ${mins}m.`);

            case 'warn':
                if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
                const wU = msg.mentions.users.first();
                if (!wU) return msg.reply("❌ Mention a user.");
                await dbRetry(() => db.collection('users').doc(wU.id).set({ 
                    warns: FieldValue.arrayUnion({ r: args.slice(1).join(' ') || "No reason", d: Date.now(), m: msg.author.tag }) 
                }, { merge: true }));
                userCache.delete(wU.id);
                return msg.reply(`⚠️ Warned ${wU.tag}.`);

            case 'warnings':
                const wrU = msg.mentions.users.first() || msg.author;
                const wrD = await getUser(wrU.id);
                return msg.reply({ embeds: [new EmbedBuilder().setTitle(`Warnings: ${wrU.tag}`).setDescription(wrD.warns?.map((w, i) => `**${i+1}.** ${w.r} (Mod: ${w.m})`).join('\n') || "Clean record.")] });

            case 'purge':
                if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
                const num = Math.min(parseInt(args[0]) || 10, 100);
                await msg.channel.bulkDelete(num, true);
                return msg.channel.send(`🧹 Purged ${num} messages.`).then(m => setTimeout(() => m.delete(), 2000));

            case 'lock':
                if (!msg.member.permissions.has(PermissionFlagsBits.ManageChannels)) return;
                await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false });
                return msg.reply("🔒 Locked.");

            case 'unlock':
                if (!msg.member.permissions.has(PermissionFlagsBits.ManageChannels)) return;
                await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: true });
                return msg.reply("🔓 Unlocked.");

            case 'addword':
                if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild)) return;
                const word = args[0];
                if (!word) return msg.reply("❌ Provide a word.");
                await dbRetry(() => db.collection('guilds').doc(msg.guild.id).update({ bannedWords: FieldValue.arrayUnion(word.toLowerCase()) }));
                guildCache.delete(msg.guild.id);
                return msg.reply(`✅ Added \`${word}\` to blacklist.`);

            case 'slots':
                const sBet = parseInt(args[0]);
                if (isNaN(sBet) || sBet < 10 || sBet > maxBet || sBet > data.balance) return msg.reply(`❌ Max bet: ${maxBet}`);
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(-sBet) }));
                userCache.delete(msg.author.id);
                let sMsg = await msg.reply("🎰 spinning...");
                for(let i=0; i<3; i++) {
                    await new Promise(r => setTimeout(r, 600));
                    await sMsg.edit(`🎰 **[ ${SLOT_ICONS[Math.floor(Math.random()*7)]} | ${SLOT_ICONS[Math.floor(Math.random()*7)]} | ${SLOT_ICONS[Math.floor(Math.random()*7)]} ]**`);
                }
                const sRes = [SLOT_ICONS[Math.floor(Math.random()*7)], SLOT_ICONS[Math.floor(Math.random()*7)], SLOT_ICONS[Math.floor(Math.random()*7)]];
                let sMul = (sRes[0] === sRes[1] && sRes[1] === sRes[2]) ? 30 : (sRes[0] === sRes[1] || sRes[1] === sRes[2] || sRes[0] === sRes[2] ? 2.5 : 0);
                if (sMul > 0) await dbRetry(() => uRef.update({ balance: FieldValue.increment(Math.floor(sBet * sMul)) }));
                userCache.delete(msg.author.id);
                return sMsg.edit(`🎰 **[ ${sRes[0]} | ${sRes[1]} | ${sRes[2]} ]**\n${sMul > 0 ? `✨ WIN! +${Math.floor(sBet * sMul)}. ${getFlirt(data.gender, "gamble")}` : '💀 LOSE.'}`);

            case 'bj': case 'blackjack':
                if (activeGames.has(msg.author.id)) return msg.reply("❌ Finish your current game!");
                const bBet = parseInt(args[0]);
                if (isNaN(bBet) || bBet < 10 || bBet > maxBet || bBet > data.balance) return msg.reply(`❌ Invalid bet.`);
                activeGames.add(msg.author.id);
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(-bBet) }));
                userCache.delete(msg.author.id);
                const deck = createDeck();
                const pH = [deck.pop(), deck.pop()], dH = [deck.pop(), deck.pop()];
                const bjE = (t, c = 0x5865F2, h = true) => new EmbedBuilder().setTitle(t).setColor(c).setDescription(getFlirt(data.gender, "gamble")).addFields({ name: 'You', value: formatHand(pH), inline: true }, { name: 'Dealer', value: h ? `\`??\` ${formatHand([dH[1]])}` : formatHand(dH), inline: true });
                const bjM = await msg.reply({ embeds: [bjE('🃏 Blackjack')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('h').setLabel('Hit').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('s').setLabel('Stand').setStyle(ButtonStyle.Secondary))] });
                bjM.createMessageComponentCollector({ filter: i => i.user.id === msg.author.id, time: 60000 }).on('collect', async i => {
                    if (i.customId === 'h') {
                        pH.push(deck.pop());
                        if (getHandVal(pH) > 21) {
                            activeGames.delete(msg.author.id);
                            return i.update({ embeds: [bjE('💥 BUST!', 0xE74C3C, false)], components: [] });
                        }
                        await i.update({ embeds: [bjE('🃏 Blackjack')] });
                    } else {
                        activeGames.delete(msg.author.id);
                        while (getHandVal(dH) < 17) dH.push(deck.pop());
                        const pV = getHandVal(pH), dV = getHandVal(dH);
                        let pay = (dV > 21 || pV > dV) ? bBet * 2 : (pV === dV ? bBet : 0);
                        if (pay > 0) await dbRetry(() => uRef.update({ balance: FieldValue.increment(pay) }));
                        userCache.delete(msg.author.id);
                        i.update({ embeds: [bjE(pay > bBet ? '🎉 WIN' : (pay === bBet ? '🤝 PUSH' : '📉 LOSS'), pay > 0 ? 0x2ECC71 : 0xE74C3C, false)], components: [] });
                    }
                });
                break;

            case 'cf': case 'coinflip':
                const cfB = parseInt(args[0]) || 50;
                if (cfB > data.balance) return msg.reply("❌ Poor.");
                const win = Math.random() > 0.5;
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(win ? cfB : -cfB) }));
                userCache.delete(msg.author.id);
                return msg.reply(win ? `🪙 WON ${cfB}!` : `🪙 LOST ${cfB}.`);

            case 'bal': case 'balance':
                return msg.reply(`💰 **${getHonorific(data.gender)}'s Wallet:** ${data.balance} | **Level:** ${lvl}\n${getFlirt(data.gender)}`);
            
            case 'daily':
                if (Date.now() - (data.lastDaily || 0) < 86400000) return msg.reply("⏳ 24h wait.");
                const dv = 1000 + (lvl * 500);
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(dv), lastDaily: Date.now() }));
                userCache.delete(msg.author.id);
                return msg.reply(`🎁 Claimed ${dv}!`);

            case 'work':
                if (Date.now() - (data.lastWork || 0) < 3600000) return msg.reply("⏳ 1h wait.");
                const p = Math.floor(Math.random() * 300) + 150;
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(p), lastWork: Date.now() }));
                userCache.delete(msg.author.id);
                return msg.reply(`💼 Earned ${p}!`);

            case 'pay': case 'give':
                const gU = msg.mentions.users.first();
                const gA = parseInt(args[1]);
                if (!gU || isNaN(gA) || gA > data.balance || gA <= 0 || gU.id === msg.author.id) return msg.reply("❌ Invalid.");
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(-gA) }));
                await dbRetry(() => db.collection('users').doc(gU.id).set({ balance: FieldValue.increment(gA) }, { merge: true }));
                userCache.delete(msg.author.id); userCache.delete(gU.id);
                return msg.reply(`💸 Sent ${gA} to ${gU.username}.`);

            case 'hunt':
                if (Date.now() - (cooldowns.get(msg.author.id + 'h') || 0) < 30000) return msg.reply("⏳ Shhh... (30s)");
                const hR = Math.random();
                const hT = hR > 0.99 ? "Legendary" : (hR > 0.9 ? "Epic" : (hR > 0.7 ? "Rare" : "Common"));
                const hA = ANIMALS[hT][Math.floor(Math.random()*ANIMALS[hT].length)];
                await dbRetry(() => uRef.update({ zoo: FieldValue.arrayUnion(hA) }));
                userCache.delete(msg.author.id);
                cooldowns.set(msg.author.id + 'h', Date.now());
                return msg.reply(`${hA.e} **WOW!** Caught a **${hT} ${hA.n}**!`);

            case 'inv': case 'inventory':
                const inv = data.zoo || [];
                const invE = new EmbedBuilder().setTitle(`🐾 ${msg.author.username}'s Zoo`).setColor(0x5865F2);
                invE.setDescription(inv.map(a => `${a.e} **${a.n}**`).join(' | ').slice(0, 2048) || "Empty.");
                return msg.reply({ embeds: [invE] });

            case 'lb': case 'leaderboard':
                const sK = args[0] === 'level' ? 'level' : 'balance';
                const snap = await dbRetry(() => db.collection('users').orderBy(sK, 'desc').limit(10).get());
                const lbStr = snap.docs.map((d, i) => `**${i+1}.** <@${d.id}> - ${sK==='level'?'Lvl '+d.data().level:'$'+d.data().balance}`).join('\n');
                return msg.reply({ embeds: [new EmbedBuilder().setTitle(`🏆 Top 10`).setDescription(`${getFlirt(data.gender, "lb")}\n\n${lbStr}`).setColor(0xF1C40F)] });

            case 'shop':
                const shopE = new EmbedBuilder().setTitle("🛒 Global Shop").setColor(0x2ECC71);
                SHOP_ITEMS.forEach(i => shopE.addFields({ name: `${i.name} — ${i.price}💰`, value: i.desc }));
                return msg.reply({ embeds: [shopE] });

            case 'buy':
                const q = args.join(' ').toLowerCase();
                const item = SHOP_ITEMS.find(i => i.name.toLowerCase().includes(q));
                if (!item || data.balance < item.price) return msg.reply("❌ Cannot buy.");
                await dbRetry(() => uRef.update({ balance: FieldValue.increment(-item.price), items: FieldValue.arrayUnion(item.id) }));
                userCache.delete(msg.author.id);
                return msg.reply(`🛍️ Bought **${item.name}**!`);

            case 'afk':
                await dbRetry(() => uRef.set({ afk: args.join(' ') || "Away." }, { merge: true }));
                userCache.delete(msg.author.id);
                return msg.reply("💤 AFK set.");

            case 'snipe':
                const s = snipes.get(msg.channel.id);
                if (!s) return msg.reply("❌ Empty.");
                return msg.reply({ embeds: [new EmbedBuilder().setAuthor({ name: s.a.tag }).setDescription(s.c || "*No text*").setTimestamp(s.t).setColor(0x5865F2)] });

            case 'userinfo':
                const uI = msg.mentions.members.first() || msg.member;
                return msg.reply({ embeds: [new EmbedBuilder().setTitle(uI.user.tag).setThumbnail(uI.user.displayAvatarURL()).addFields({ name: 'ID', value: `\`${uI.id}\``, inline: true }, { name: 'Level', value: `${lvl}`, inline: true }).setColor(0x5865F2)] });

            case 'ping': return msg.reply(`🏓 **${client.ws.ping}ms**`);

            case 'help':
                return msg.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Titan v25.0 PRO").setColor(0x5865F2).addFields(
                    { name: '🔨 Admin', value: '`ban`, `kick`, `timeout`, `warn`, `warnings`, `purge`, `lock`, `unlock`, `addword`' },
                    { name: '🎰 Casino', value: '`bj`, `slots`, `cf`' },
                    { name: '💰 Economy', value: '`bal`, `daily`, `work`, `pay`, `lb`, `shop`, `buy`, `hunt`, `inv`' },
                    { name: '💤 Utility', value: '`afk`, `snipe`, `userinfo`, `ping`' }
                ).setFooter({ text: "Titan Core | Stability: Hyper" })] });
        }
    } catch (e) { 
        console.error(e); 
        msg.reply("⚠️ Network delay. Try again in 2s.").catch(() => {});
    } finally { activeHandlers--; }
});

client.login(process.env.DISCORD_TOKEN);
