// =============================
// BongBot 2.0 - index.js (FIXED)
// =============================

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const { createClient } = require("redis");

// =============================
// ENV / FLAGS
// =============================
const ENABLE_MUSIC = (process.env.ENABLE_MUSIC || "false").toLowerCase() === "true";
const AUTO_REPLY_DEFAULT = (process.env.AUTO_REPLY_DEFAULT || "true").toLowerCase() === "true";
const AUTO_REPLY_COOLDOWN_MS = Number(process.env.AUTO_REPLY_COOLDOWN_MS || 2500);
const DATA_VERSION = String(process.env.DATA_VERSION || "0");

if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!process.env.REDIS_URL) throw new Error("REDIS_URL missing");

// =============================
// CONFIG
// =============================
const BOT_VERSION = "2.0.1";
const ALERT_CHANNEL_ID = "757698153494609943";

// Roulette
const ROULETTE_WINDOW_MS = 90 * 1000;
const MIN_BET = 420;

// =============================
// XP + CRIT CONFIG
// =============================
const XP_BONG = 420;
const XP_DAB = 710;
const XP_EDDY = 840;
const XP_JOINT = 840;

const ADD_CRIT_BONG = 0.042;
const ADD_CRIT_PEN  = 0.021;
const ADD_CRIT_DAB  = 0.071;
const ADD_CRIT_EDDY = 0.084;
const ADD_CRIT_JOINT = 0.042;

const BASE_CRIT_START = 0;

const CRIT_PAYOUT_GENERAL = 4269;
const CRIT_PAYOUT_DAB = 7100;

// =============================
// REDIS
// =============================
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: process.env.REDIS_URL.startsWith("rediss://")
    ? { tls: true, rejectUnauthorized: false }
    : undefined,
});

const DATA_KEY = "bongbot2:data";
const META_KEY = "bongbot2:meta";

redis.on("error", console.error);

// =============================
// DISCORD
// =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// =============================
// DATA MODEL
// =============================
let data = {
  users: {},       // xp, allTimeRips
  activity: {},    // daily/weekly/monthly/yearly + streak + crit
  season: { id: null, start: null, endExclusive: null, active: false },
  seasonStats: {},
  yearly: { year: null, totals: {} },
  autoReplyEnabled: AUTO_REPLY_DEFAULT,
  topDaily: [] // [{ date, uid, count }]
};

// =============================
// TIME (America/Chicago)
// =============================
function chicagoDateStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function chicagoWeekKey(d = new Date()) {
  // Week starts Sunday
  const cd = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = cd.getDay(); // 0 Sun
  cd.setDate(cd.getDate() - day);
  return chicagoDateStr(cd); // key = Sunday date
}

function monthKey(d = new Date()) {
  const s = chicagoDateStr(d);
  return s.slice(0, 7); // YYYY-MM
}

// =============================
// RESET ON VERSION CHANGE
// =============================
async function checkVersionReset() {
  const raw = await redis.get(META_KEY);
  const meta = raw ? JSON.parse(raw) : {};

  if (meta.version !== DATA_VERSION) {
    console.log("🔥 DATA_VERSION changed — wiping XP/activity");
    data = {
      users: {},
      activity: {},
      season: { id: null, start: null, endExclusive: null, active: false },
      seasonStats: {},
      yearly: { year: null, totals: {} },
      autoReplyEnabled: AUTO_REPLY_DEFAULT,
      topDaily: []
    };
    await redis.set(DATA_KEY, JSON.stringify(data));
    await redis.set(META_KEY, JSON.stringify({ version: DATA_VERSION }));
  }
}

// =============================
// LOAD / SAVE
// =============================
async function loadData() {
  const raw = await redis.get(DATA_KEY);
  if (raw) data = JSON.parse(raw);

  // normalize for safety
  if (!data.users) data.users = {};
  if (!data.activity) data.activity = {};
  if (!data.season) data.season = { id: null, start: null, endExclusive: null, active: false };
  if (!data.seasonStats) data.seasonStats = {};
  if (!data.yearly) data.yearly = { year: null, totals: {} };
  if (!data.yearly.totals) data.yearly.totals = {};
  if (typeof data.autoReplyEnabled !== "boolean") data.autoReplyEnabled = AUTO_REPLY_DEFAULT;
  if (!Array.isArray(data.topDaily)) data.topDaily = [];
}

async function saveData() {
  await redis.set(DATA_KEY, JSON.stringify(data));
}

// =============================
// ENSURE USER
// =============================
function ensureUser(uid) {
  if (!data.users[uid]) data.users[uid] = { xp: 0, allTimeRips: 0 };

  if (!data.activity[uid]) {
    data.activity[uid] = {
      day: null,
      daily: 0,
      week: null,
      weekly: 0,
      month: null,
      monthly: 0,
      year: null,
      yearly: 0,
      streak: 0,
      critChance: BASE_CRIT_START
    };
  }

  const y = new Date().getFullYear();
  if (!data.yearly.year) data.yearly.year = y;
  if (!data.yearly.totals[uid]) data.yearly.totals[uid] = { yearRips: 0, yearGambleNet: 0 };

  if (!data.seasonStats[uid]) {
    data.seasonStats[uid] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
  }
}

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

// =============================
// CATEGORY DETECTION
// =============================
function detectCategory(msg) {
  const t = msg.toLowerCase();

  if (/fat dabs for jesus|fat dabs|dab rip|dab rips|\bdabs?\b/.test(t))
    return { name: "DAB", xp: XP_DAB, add: ADD_CRIT_DAB };

  if (/\beddys\b/.test(t))
    return { name: "EDDYS", xp: XP_EDDY, add: ADD_CRIT_EDDY };

  if (/joint|doobie|doink|smokin a|joint time|doobie time|doink30/.test(t))
    return { name: "JOINT", xp: XP_JOINT, add: ADD_CRIT_JOINT };

  if (/pen rip|pen rips|penjamin/.test(t))
    return { name: "PEN", xp: XP_BONG, add: ADD_CRIT_PEN };

  if (/rip|rips|bong|zong|zonk|dong|get high|light up|smoke/.test(t))
    return { name: "RIP", xp: XP_BONG, add: ADD_CRIT_BONG };

  return null;
}

// =============================
// CRIT ROLL (ADD ONLY)
// =============================
function rollCrit(state, add) {
  const chanceBefore = state.critChance;
  const rollChance = Math.min(1, Math.max(0, chanceBefore));
  const hit = Math.random() < rollChance;

  if (hit) state.critChance = BASE_CRIT_START;
  else state.critChance += add;

  return { hit, used: chanceBefore };
}

// =============================
// TOP DAILY (GLOBAL TOP 3)
// =============================
function updateTopDaily(dateStr, uid, count) {
  data.topDaily = data.topDaily.filter(x => !(x.date === dateStr && x.uid === uid));
  data.topDaily.push({ date: dateStr, uid, count });
  data.topDaily.sort((a, b) => b.count - a.count);
  data.topDaily = data.topDaily.slice(0, 3);
}

// =============================
// COMMAND LIST
// =============================
const COMMANDS = [
  { name: "!commands", desc: "Show all commands" },
  { name: "!help <cmd>", desc: "Help for a command" },
  { name: "!ping", desc: "Health check" },
  { name: "!version", desc: "Bot version" },
  { name: "!uptime", desc: "How long bot has been running" },

  { name: "!ripstats", desc: "Your stats (XP, rips, counts, crit, streak)" },
  { name: "!crit", desc: "Show current crit chance + add rates" },
  { name: "!mostrips", desc: "Top 3 single-day records (global)" },
  { name: "!toprippers", desc: "Top rippers leaderboard (all-time)" },

  { name: "!toggleautoreply", desc: "Admin: toggle auto replies" },
  { name: "!addexp @user <amt>", desc: "Admin: add XP" },
  { name: "!addrips @user <amt>", desc: "Admin: add all-time rips" },
];

function formatCommands() {
  return `📜 **BongBot Commands**\n` + COMMANDS.map(c => `• \`${c.name}\` — ${c.desc}`).join("\n");
}

// =============================
// MESSAGE HANDLER
// =============================
const lastReplyAt = new Map();
const START_TIME = Date.now();

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    await loadData();

    const raw = msg.content.trim();
    const content = raw.toLowerCase();
    const uid = msg.author.id;

    ensureUser(uid);

    // ---------- COMMANDS FIRST ----------
    if (content.startsWith("!")) {
      const parts = raw.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (cmd === "!ping") return msg.reply("pong ✅");
      if (cmd === "!version") return msg.reply(`BongBot v${BOT_VERSION}`);
      if (cmd === "!uptime") {
        const ms = Date.now() - START_TIME;
        const mins = Math.floor(ms / 60000);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        return msg.reply(`⏱️ Uptime: **${hrs}h ${rem}m**`);
      }

      if (cmd === "!commands") return msg.reply(formatCommands());
      if (cmd === "!help") return msg.reply("Use `!commands` for the full list.");

      if (cmd === "!toggleautoreply") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        data.autoReplyEnabled = !data.autoReplyEnabled;
        await saveData();
        return msg.reply(`Auto replies: **${data.autoReplyEnabled ? "ON" : "OFF"}**`);
      }

      if (cmd === "!crit") {
        const a = data.activity[uid];
        return msg.reply(
          `🎯 Crit chance: **${(a.critChance * 100).toFixed(2)}%**\n` +
          `Adds on miss:\n` +
          `• Bong: +4.20%\n` +
          `• Pen: +2.10%\n` +
          `• Dab: +7.10%\n` +
          `• Eddys: +8.40%\n` +
          `• Joint: +4.20%`
        );
      }

      if (cmd === "!ripstats") {
        const u = data.users[uid];
        const a = data.activity[uid];
        return msg.reply(
          `👤 **Your Stats**\n` +
          `XP: **${u.xp}**\n` +
          `All-time rips: **${u.allTimeRips}**\n\n` +
          `📊 **Counts (Chicago time)**\n` +
          `Today: **${a.daily}**\n` +
          `This week: **${a.weekly}**\n` +
          `This month: **${a.monthly}**\n` +
          `This year: **${a.yearly}**\n\n` +
          `🔥 Streak: **${a.streak}**\n` +
          `🎯 Crit chance: **${(a.critChance * 100).toFixed(2)}%**`
        );
      }

      if (cmd === "!mostrips") {
        if (!data.topDaily.length) return msg.reply("No daily records yet.");
        const lines = data.topDaily.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.count}** on **${r.date}**`);
        return msg.reply(`🏆 **Most Rips In A Day (Top 3)**\n${lines.join("\n")}`);
      }

      if (cmd === "!toprippers") {
        const entries = Object.entries(data.users)
          .map(([id, u]) => ({ id, rips: u.allTimeRips || 0 }))
          .sort((a, b) => b.rips - a.rips)
          .slice(0, 10);

        if (!entries.length) return msg.reply("No rip data yet.");
        const lines = entries.map((e, i) => `**${i + 1}.** <@${e.id}> — **${e.rips} rips**`);
        return msg.reply(`🏁 **Top Rippers (All-time)**\n${lines.join("\n")}`);
      }

      if (cmd === "!addexp") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        const target = msg.mentions.users.first();
        const amt = parseInt(args[1], 10);
        if (!target || Number.isNaN(amt)) return msg.reply("Usage: `!addexp @user <amount>`");

        ensureUser(target.id);
        data.users[target.id].xp = Math.max(0, data.users[target.id].xp + amt);
        await saveData();
        return msg.reply(`✅ Added **${amt} XP** to <@${target.id}>. Now **${data.users[target.id].xp} XP**.`);
      }

      if (cmd === "!addrips") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        const target = msg.mentions.users.first();
        const amt = parseInt(args[1], 10);
        if (!target || Number.isNaN(amt) || amt <= 0) return msg.reply("Usage: `!addrips @user <amount>`");

        ensureUser(target.id);
        data.users[target.id].allTimeRips += amt;
        await saveData();
        return msg.reply(`✅ Added **${amt} all-time rips** to <@${target.id}>.`);
      }

      // If it's a command we don't handle, stop here so it doesn't count as a rip.
      return;
    }

    // ---------- RIP HANDLING (NON-COMMAND MESSAGES ONLY) ----------
    const cat = detectCategory(content);
    if (!cat) return;

    const a = data.activity[uid];
    const u = data.users[uid];

    const today = chicagoDateStr();
    const wk = chicagoWeekKey();
    const mo = monthKey();
    const yr = new Date().getFullYear();

    // reset counters by periods
    if (a.day !== today) { a.day = today; a.daily = 0; a.streak += 1; }
    if (a.week !== wk) { a.week = wk; a.weekly = 0; }
    if (a.month !== mo) { a.month = mo; a.monthly = 0; }
    if (a.year !== yr) { a.year = yr; a.yearly = 0; }

    a.daily++; a.weekly++; a.monthly++; a.yearly++;
    u.allTimeRips++;

    updateTopDaily(today, uid, a.daily);

    const crit = rollCrit(a, cat.add);
    let xp = cat.xp;
    if (crit.hit) xp = (cat.name === "DAB") ? CRIT_PAYOUT_DAB : CRIT_PAYOUT_GENERAL;
    u.xp += xp;

    await saveData();

    // Auto reply (cooldown)
    if (!data.autoReplyEnabled) return;

    const last = lastReplyAt.get(uid) || 0;
    if (Date.now() - last < AUTO_REPLY_COOLDOWN_MS) return;
    lastReplyAt.set(uid, Date.now());

    return msg.reply(
      `💨 **${cat.name} REGISTERED**\n` +
      `🎯 Crit used: **${(crit.used * 100).toFixed(2)}%**\n` +
      (crit.hit ? `💥 **CRIT HIT!**\n` : "") +
      `💰 +${xp} XP | Total: **${u.xp}**\n` +
      `🔥 Streak: **${a.streak}** | Today: **${a.daily}**`
    );

  } catch (e) {
    console.error("messageCreate error:", e);
    try { await msg.reply("❌ Internal error (check Railway logs)."); } catch {}
  }
});

// =============================
// STARTUP
// =============================
(async () => {
  try {
    await redis.connect();
    await checkVersionReset();
    await loadData();
    await client.login(process.env.BOT_TOKEN);
    console.log(`🔥 BongBot online as ${client.user.tag}`);
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();

// =============================
// VERSIONED RESET ON STARTUP
// =============================
async function checkVersionReset() {
  const raw = await redis.get(META_KEY);
  const meta = raw ? JSON.parse(raw) : {};
  if (meta.version !== DATA_VERSION) {
    console.log("🔥 DATA_VERSION changed — wiping XP/activity");
    data = {
      users: {},
      activity: {},
      season: { id: null, start: null, endExclusive: null, active: false },
      seasonStats: {},
      yearly: { year: null, totals: {} },
      autoReplyEnabled: AUTO_REPLY_DEFAULT,
      topDaily: []
    };
    await redis.set(DATA_KEY, JSON.stringify(data));
    await redis.set(META_KEY, JSON.stringify({ version: DATA_VERSION }));
  }
}
