// =============================
// BongBot 2.0 - index.js (FINAL)
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
const BOT_VERSION = "2.0.0";
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
const ROULETTE_KEY = "bongbot2:roulette";

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
  autoReplyEnabled: AUTO_REPLY_DEFAULT
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
  const cd = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = cd.getDay(); // 0 Sun
  cd.setDate(cd.getDate() - day);
  return chicagoDateStr(cd);
}

function monthKey(d = new Date()) {
  const s = chicagoDateStr(d);
  return s.slice(0, 7);
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
      autoReplyEnabled: AUTO_REPLY_DEFAULT
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

  if (hit) {
    state.critChance = BASE_CRIT_START;
  } else {
    state.critChance += add;
  }

  return { hit, used: chanceBefore };
}

// =============================
// COMMAND REGISTRY
// =============================
const COMMANDS = [
  "!commands","!help <cmd>","!ping","!version","!uptime",
  "!ripstats","!crit","!season","!seasonboard","!yearboard",
  "!mostrips","!toprippers",
  "!red <bet>","!black <bet>","!number <n|00> <bet>","!roulette",
  "!addexp @user <amt>","!addrips @user <amt>","!toggleautoreply"
];

// =============================
// MESSAGE HANDLER
// =============================
const lastReplyAt = new Map();
const START_TIME = Date.now();

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  await loadData();

  const raw = msg.content.trim();
  const content = raw.toLowerCase();
  const uid = msg.author.id;

  ensureUser(uid);

  // -------- BASIC COMMANDS --------
  if (content === "!ping") return msg.reply("pong ✅");
  if (content === "!version") return msg.reply(`BongBot v${BOT_VERSION}`);
  if (content === "!uptime") {
    const mins = Math.floor((Date.now() - START_TIME) / 60000);
    return msg.reply(`⏱️ Uptime: ${mins} min`);
  }

  if (content === "!commands")
    return msg.reply(`📜 **Commands**\n${COMMANDS.map(c => `• ${c}`).join("\n")}`);

  if (content.startsWith("!help"))
    return msg.reply("ℹ️ Use `!commands` to see everything.");

  if (content === "!toggleautoreply") {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return msg.reply("Admins only.");
    data.autoReplyEnabled = !data.autoReplyEnabled;
    await saveData();
    return msg.reply(`Auto replies: **${data.autoReplyEnabled ? "ON" : "OFF"}**`);
  }

  if (content === "!crit") {
    const a = data.activity[uid];
    return msg.reply(
      `🎯 Crit chance: **${(a.critChance * 100).toFixed(2)}%**\n` +
      `Adds → Bong +4.20 | Pen +2.10 | Dab +7.10 | Eddys +8.40 | Joint +4.20`
    );
  }

  // -------- RIP HANDLING --------
  const cat = detectCategory(content);
  if (!cat) return;

  const a = data.activity[uid];
  const u = data.users[uid];

  const today = chicagoDateStr();
  const wk = chicagoWeekKey();
  const mo = monthKey();
  const yr = new Date().getFullYear();

  if (a.day !== today) {
    a.day = today;
    a.daily = 0;
    a.streak += 1;
  }
  if (a.week !== wk) { a.week = wk; a.weekly = 0; }
  if (a.month !== mo) { a.month = mo; a.monthly = 0; }
  if (a.year !== yr) { a.year = yr; a.yearly = 0; }

  a.daily++; a.weekly++; a.monthly++; a.yearly++;
  u.allTimeRips++;

  const crit = rollCrit(a, cat.add);
  let xp = cat.xp;
  if (crit.hit) xp = cat.name === "DAB" ? CRIT_PAYOUT_DAB : CRIT_PAYOUT_GENERAL;

  u.xp += xp;

  await saveData();

  // Auto reply (cooldown)
  if (!data.autoReplyEnabled) return;
  const last = lastReplyAt.get(uid) || 0;
  if (Date.now() - last < AUTO_REPLY_COOLDOWN_MS) return;
  lastReplyAt.set(uid, Date.now());

  return msg.reply(
    `💨 **${cat.name} REGISTERED**\n` +
    `🎯 Crit used: ${(crit.used * 100).toFixed(2)}%\n` +
    (crit.hit ? "💥 **CRIT HIT!**\n" : "") +
    `💰 +${xp} XP | Total XP: ${u.xp}\n` +
    `🔥 Streak: ${a.streak} | Today: ${a.daily}`
  );
});

// =============================
// STARTUP
// =============================
(async () => {
  await redis.connect();
  await checkVersionReset();
  await loadData();
  await client.login(process.env.BOT_TOKEN);
})();
