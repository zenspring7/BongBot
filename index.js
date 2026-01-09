// =============================
// BongBot 2.0 - FULL index.js
// Node.js + discord.js v14 + Redis
// =============================

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const { createClient } = require("redis");

// =============================
// ENV / FLAGS
// =============================
const ENABLE_MUSIC = (process.env.ENABLE_MUSIC || "false").toLowerCase() === "true";
const DATA_VERSION = String(process.env.DATA_VERSION || "0");

// Auto replies (default ON). Cooldown default 0ms because you said "after every message".
const AUTO_REPLY_DEFAULT = (process.env.AUTO_REPLY_DEFAULT || "true").toLowerCase() === "true";
const AUTO_REPLY_COOLDOWN_MS = Number(process.env.AUTO_REPLY_COOLDOWN_MS || 0);

const BOT_VERSION = "2.0.9-full";

console.log("Booting BongBot 2.0 FULL...");
console.log("ENABLE_MUSIC:", ENABLE_MUSIC);
console.log("DATA_VERSION:", DATA_VERSION);
console.log("AUTO_REPLY_DEFAULT:", AUTO_REPLY_DEFAULT);
console.log("AUTO_REPLY_COOLDOWN_MS:", AUTO_REPLY_COOLDOWN_MS);
console.log("Has BOT_TOKEN:", !!process.env.BOT_TOKEN);
console.log("Has REDIS_URL:", !!process.env.REDIS_URL);

if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing in Railway variables.");
if (!process.env.REDIS_URL) throw new Error("REDIS_URL missing in Railway variables (BongBot service).");

// =============================
// CONFIG
// =============================
const ALERT_CHANNEL_ID = "757698153494609943";

// Roulette
const ROULETTE_WINDOW_MS = 90 * 1000;
const MIN_BET = 420;

// =============================
// XP + CRIT CONFIG
// =============================
const XP_BONG = 420;     // bong/general + pen
const XP_DAB = 710;      // dabs
const XP_EDDYS = 840;    // edibles
const XP_JOINT = 840;    // joint/doobie/doink category

// Crit add amounts (ADD ONLY, no x3)
const ADD_CRIT_BONG  = 0.042; // 4.20%
const ADD_CRIT_PEN   = 0.021; // 2.10%
const ADD_CRIT_DAB   = 0.071; // 7.10%
const ADD_CRIT_EDDYS = 0.084; // 8.40%
const ADD_CRIT_JOINT = 0.042; // joint crit added

const BASE_CRIT_START = 0; // daily reset / crit reset returns to this

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

redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("Redis connecting..."));
redis.on("ready", () => console.log("Redis ready ✅"));

const DATA_KEY = "bongbot2:data";
const META_KEY = "bongbot2:meta";
const ROULETTE_KEY = "bongbot2:roulette";

// =============================
// DISCORD
// =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // REQUIRED for prefix commands
    GatewayIntentBits.GuildVoiceStates // used if music enabled
  ],
});

// =============================
// TIME (America/Chicago)
// =============================
const CHI_TZ = "America/Chicago";

function chiParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CHI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    y: Number(get("year")),
    m: Number(get("month")), // 1-12
    d: Number(get("day")),   // 1-31
  };
}

function chiDateStr(d = new Date()) {
  const { y, m, d: day } = chiParts(d);
  const mm = String(m).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function chiMonthKey(d = new Date()) {
  const { y, m } = chiParts(d);
  return `${y}-${String(m).padStart(2, "0")}`;
}

// week key: Sunday date in Chicago time
function chiWeekKey(d = new Date()) {
  // convert to a Date that represents Chicago local time by using locale string trick
  const cd = new Date(d.toLocaleString("en-US", { timeZone: CHI_TZ }));
  const day = cd.getDay(); // 0 Sun
  cd.setDate(cd.getDate() - day);
  return chiDateStr(cd);
}

// =============================
// DATA MODEL
// =============================
let data = {
  // per user: { xp, allTimeRips }
  userStats: {},

  // per user: rolling counts + streak + crit chance
  activity: {},

  // Season info
  season: { id: null, start: null, endExclusive: null, active: false },

  // Season stats: per user season rips + gambling totals
  seasonStats: {},

  // Yearly totals (sum of seasons)
  yearly: { year: null, totals: {} },

  // QoL settings
  settings: {
    autoReplyEnabled: AUTO_REPLY_DEFAULT
  },

  // Global highscores
  highscores: {
    topDaily: [] // [{ date, userId, count }]
  }
};

// =============================
// VERSIONED RESET (ONLY WHEN DATA_VERSION CHANGES)
// =============================
async function maybeWipeOnVersionBump() {
  const raw = await redis.get(META_KEY);
  const meta = raw ? JSON.parse(raw) : {};
  if (meta.dataVersion !== DATA_VERSION) {
    console.log("🔥 DATA_VERSION changed — wiping saved data (intentional).");
    data = {
      userStats: {},
      activity: {},
      season: { id: null, start: null, endExclusive: null, active: false },
      seasonStats: {},
      yearly: { year: null, totals: {} },
      settings: { autoReplyEnabled: AUTO_REPLY_DEFAULT },
      highscores: { topDaily: [] }
    };
    await redis.set(DATA_KEY, JSON.stringify(data));
    await redis.set(META_KEY, JSON.stringify({ dataVersion: DATA_VERSION }));
  }
}

// =============================
// LOAD / SAVE
// =============================
async function loadData() {
  const raw = await redis.get(DATA_KEY);
  if (raw) data = JSON.parse(raw);

  // normalize
  if (!data.userStats) data.userStats = {};
  if (!data.activity) data.activity = {};
  if (!data.season) data.season = { id: null, start: null, endExclusive: null, active: false };
  if (!data.seasonStats) data.seasonStats = {};
  if (!data.yearly) data.yearly = { year: null, totals: {} };
  if (!data.yearly.totals) data.yearly.totals = {};
  if (!data.settings) data.settings = { autoReplyEnabled: AUTO_REPLY_DEFAULT };
  if (typeof data.settings.autoReplyEnabled !== "boolean") data.settings.autoReplyEnabled = AUTO_REPLY_DEFAULT;
  if (!data.highscores) data.highscores = { topDaily: [] };
  if (!Array.isArray(data.highscores.topDaily)) data.highscores.topDaily = [];
}

async function saveData() {
  await redis.set(DATA_KEY, JSON.stringify(data));
}

// =============================
// USER HELPERS
// =============================
function ensureUser(userId) {
  if (!data.userStats[userId]) {
    data.userStats[userId] = { xp: 0, allTimeRips: 0 };
  }

  if (!data.activity[userId]) {
    data.activity[userId] = {
      day: null,
      daily: 0,
      weekKey: null,
      weekly: 0,
      monthKey: null,
      monthly: 0,
      year: null,
      yearly: 0,
      streak: 0,
      critChance: BASE_CRIT_START
    };
  }

  if (!data.seasonStats[userId]) {
    data.seasonStats[userId] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
  }

  const y = new Date().getFullYear();
  if (!data.yearly.year) data.yearly.year = y;
  if (data.yearly.year !== y) data.yearly = { year: y, totals: {} };
  if (!data.yearly.totals[userId]) {
    data.yearly.totals[userId] = { yearRips: 0, yearGambleNet: 0 };
  }
}

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

// =============================
// SEASONS (Chicago time)
// =============================
// January special: Jan 9–15 inclusive => endExclusive Jan 16
// Other months: days 1–7 => endExclusive day 8
function getSeasonWindowForChicagoNow() {
  const { y, m } = chiParts(new Date());
  const monthStr = String(m).padStart(2, "0");

  if (m === 1) {
    const start = `${y}-01-09`;
    const endExclusive = `${y}-01-16`;
    return { start, endExclusive, id: `${y}-01@${start}` };
  }

  const start = `${y}-${monthStr}-01`;
  const endExclusive = `${y}-${monthStr}-08`;
  return { start, endExclusive, id: `${y}-${monthStr}@${start}` };
}

function isDateInWindow(dateStr, startStr, endExclusiveStr) {
  return dateStr >= startStr && dateStr < endExclusiveStr;
}

function getSeasonNet(uid) {
  const s = data.seasonStats[uid] || { seasonGambleBet: 0, seasonGambleWon: 0 };
  return (s.seasonGambleWon || 0) - (s.seasonGambleBet || 0);
}

async function announceSeasonWinners() {
  const channel = client.channels.cache.get(ALERT_CHANNEL_ID);
  if (!channel) return;

  const entries = Object.entries(data.seasonStats);
  if (!entries.length) {
    await channel.send("🏁 **Season ended!** No season stats were recorded this season.");
    return;
  }

  const ripSorted = [...entries].sort((a, b) => (b[1].seasonRips || 0) - (a[1].seasonRips || 0));
  const [ripWinnerId, ripWinnerStats] = ripSorted[0];

  const xpSorted = [...entries].sort((a, b) => getSeasonNet(b[0]) - getSeasonNet(a[0]));
  const [xpWinnerId] = xpSorted[0];
  const xpWinnerNet = getSeasonNet(xpWinnerId);

  await channel.send(
    "🏁 **SEASON COMPLETE** 🏁\n" +
      `🥇 **RIP WINNER:** <@${ripWinnerId}> — **${ripWinnerStats.seasonRips || 0} rips**\n` +
      `💰 **XP (GAMBLING NET) WINNER:** <@${xpWinnerId}> — **${xpWinnerNet} net XP**\n` +
      `📌 Use \`!seasonboard\` to see standings and \`!yearboard\` for yearly totals.`
  );
}

async function maybeUpdateSeasonAndFinalizeIfNeeded() {
  const today = chiDateStr(new Date());
  const window = getSeasonWindowForChicagoNow();
  const currentlyActive = isDateInWindow(today, window.start, window.endExclusive);

  if (!data.season.id) {
    data.season = { ...window, active: currentlyActive };
    await saveData();
    return;
  }

  const seasonIdChanged = data.season.id !== window.id;

  if ((data.season.active && !currentlyActive) || seasonIdChanged) {
    // finalize old season
    await announceSeasonWinners();

    // roll into yearly totals
    for (const [uid, s] of Object.entries(data.seasonStats)) {
      ensureUser(uid);
      const net = (s.seasonGambleWon || 0) - (s.seasonGambleBet || 0);
      data.yearly.totals[uid].yearRips += (s.seasonRips || 0);
      data.yearly.totals[uid].yearGambleNet += net;
    }

    // reset season stats for next season
    data.seasonStats = {};
  }

  data.season = { ...window, active: currentlyActive };
  await saveData();
}

// =============================
// VARIANTS / TRIGGERS (FULL)
// =============================
const BONG_VARIANTS = [
  "bong rip","bong rips","bong ripz",
  "b0ng rip","b0ng rips","b0ng ripz",
  "b0nk rip","b0nk rips","b0nk ripz",
  "zong rip","zong rips","zong ripz",
  "z0ng rip","z0ng rips","z0ng ripz",
  "zonk rip","zonk rips","zonk ripz",
  "z0nk rip","z0nk rips","z0nk ripz",
  "dong dip","dong rips","dong ripz",
  "d0ng rip","d0ng rips","d0ng ripz",
];

const PEN_TRIGGERS = [
  "pen rip","pen rips","penjamin rips"
];

const RIP_MISC_TRIGGERS = [
  "ripper","rippers","light up","smoke",
  "get high","get high baby","get high baby yeah"
];

const DAB_TRIGGERS = [
  "dabs","dab rip","dab rips","fat dabs","fat dabs for jesus"
];

const EDDY_TRIGGERS = [
  "eddys"
];

const JOINT_TRIGGERS = [
  "joint","doobie","doink",
  "joint time","doobie time","doink joint time",
  "smokin a doobie","smokin a joint","smokin a doink",
  "doink30","joint30","doobie30"
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function includesAny(text, arr) {
  return arr.some((p) => text.includes(p));
}

// Detect category + XP + crit add + reply variant word
function detectCategory(contentLower) {
  const t = contentLower;

  // dabs
  if (/\bdab\b/.test(t) || includesAny(t, DAB_TRIGGERS)) {
    return { type: "dab", label: "DAB", xp: XP_DAB, add: ADD_CRIT_DAB, variant: "dab rip" };
  }

  // eddys
  if (includesAny(t, EDDY_TRIGGERS)) {
    return { type: "eddys", label: "EDDYS", xp: XP_EDDYS, add: ADD_CRIT_EDDYS, variant: "eddys" };
  }

  // joints
  if (includesAny(t, JOINT_TRIGGERS)) {
    return { type: "joint", label: "JOINT", xp: XP_JOINT, add: ADD_CRIT_JOINT, variant: pick(["joint", "doobie", "doink"]) };
  }

  // pen
  if (includesAny(t, PEN_TRIGGERS)) {
    return { type: "pen", label: "PEN RIP", xp: XP_BONG, add: ADD_CRIT_PEN, variant: "pen rip" };
  }

  // bong/general rip
  if (/\brips?\b/.test(t) || includesAny(t, BONG_VARIANTS) || includesAny(t, RIP_MISC_TRIGGERS) || t.includes("bong") || t.includes("zong") || t.includes("zonk") || t.includes("dong")) {
    // If it contains an explicit bong-variant phrase, pick one to echo; else pick a bong-style variant
    const v = BONG_VARIANTS.find(x => t.includes(x)) || pick(BONG_VARIANTS);
    return { type: "bong", label: "RIP", xp: XP_BONG, add: ADD_CRIT_BONG, variant: v };
  }

  return null;
}

// =============================
// CRIT (ADD ONLY, reset on crit, reset daily)
// =============================
function rollCrit(activityUser, add) {
  const chanceBefore = activityUser.critChance;
  const rollChance = Math.min(1, Math.max(0, chanceBefore));
  const hit = Math.random() < rollChance;

  if (hit) activityUser.critChance = BASE_CRIT_START;
  else activityUser.critChance += add;

  return { hit, used: chanceBefore, addApplied: add };
}

// =============================
// GLOBAL TOP DAILY (Top 3)
// =============================
function updateTopDaily(dateStr, userId, dailyCount) {
  const list = data.highscores.topDaily || [];
  // remove any existing record for same user/date
  const filtered = list.filter(r => !(r.date === dateStr && r.userId === userId));
  filtered.push({ date: dateStr, userId, count: dailyCount });
  filtered.sort((a, b) => b.count - a.count);
  data.highscores.topDaily = filtered.slice(0, 3);
}

// =============================
// ROULETTE (American wheel) — Redis backed
// =============================
const WHEEL = [
  "0","00","1","2","3","4","5","6","7","8","9","10",
  "11","12","13","14","15","16","17","18","19","20",
  "21","22","23","24","25","26","27","28","29","30",
  "31","32","33","34","35","36"
];

const RED_NUMS = new Set(["1","3","5","7","9","12","14","16","18","19","21","23","25","27","30","32","34","36"]);
function getColor(num) {
  if (num === "0" || num === "00") return "green";
  return RED_NUMS.has(num) ? "red" : "black";
}

function pickSpin() {
  const num = WHEEL[Math.floor(Math.random() * WHEEL.length)];
  return { num, color: getColor(num) };
}

async function getRouletteRound() {
  const raw = await redis.get(ROULETTE_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function setRouletteRound(obj) {
  await redis.set(ROULETTE_KEY, JSON.stringify(obj));
}
async function clearRouletteRound() {
  await redis.del(ROULETTE_KEY);
}

async function ensureRouletteTimer() {
  const round = await getRouletteRound();
  if (!round) return;

  const msLeft = round.endTime - Date.now();
  if (msLeft <= 0) {
    await resolveRouletteRound();
    return;
  }

  setTimeout(async () => {
    await resolveRouletteRound();
  }, msLeft);
}

async function startRouletteIfNeeded(channelId) {
  const existing = await getRouletteRound();
  if (existing) return existing;

  const round = {
    channelId,
    startTime: Date.now(),
    endTime: Date.now() + ROULETTE_WINDOW_MS,
    bets: [] // { userId, type, pick, amount }
  };

  await setRouletteRound(round);

  const channel = client.channels.cache.get(channelId);
  if (channel) {
    await channel.send(
      `🎰 **ROULETTE OPEN** — You have **90 seconds** to bet!\n` +
      `Commands:\n` +
      `• \`!red <bet>\`\n` +
      `• \`!black <bet>\`\n` +
      `• \`!number <0-36|00> <bet>\`\n` +
      `Min bet: **${MIN_BET} XP**`
    );
  }

  setTimeout(async () => {
    await resolveRouletteRound();
  }, ROULETTE_WINDOW_MS);

  return round;
}

function calcPayout(bet, spin) {
  if (bet.type === "red" || bet.type === "black") {
    if (spin.color === bet.type) return bet.amount * 2;
    return 0;
  }
  if (bet.type === "number") {
    if (spin.num === bet.pick) return bet.amount * 36;
    return 0;
  }
  return 0;
}

async function placeBet({ userId, channelId, type, pick, amount }) {
  if (amount < MIN_BET) {
    return { ok: false, msg: `Min bet is **${MIN_BET} XP**.` };
  }

  ensureUser(userId);

  if (data.userStats[userId].xp < amount) {
    return { ok: false, msg: `You only have **${data.userStats[userId].xp} XP**.` };
  }

  // escrow immediately
  data.userStats[userId].xp -= amount;

  // track season gambling
  if (!data.seasonStats[userId]) data.seasonStats[userId] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
  data.seasonStats[userId].seasonGambleBet += amount;

  await saveData();

  const round = await startRouletteIfNeeded(channelId);
  round.bets.push({ userId, type, pick, amount });
  await setRouletteRound(round);

  const secondsLeft = Math.max(0, Math.ceil((round.endTime - Date.now()) / 1000));
  return {
    ok: true,
    msg: `✅ Bet placed: **${amount} XP** on **${type === "number" ? `number ${pick}` : type}**. (⏳ ~${secondsLeft}s left)`
  };
}

async function resolveRouletteRound() {
  const round = await getRouletteRound();
  if (!round) return;

  await clearRouletteRound();

  const channel = client.channels.cache.get(round.channelId);
  const spin = pickSpin();

  if (!round.bets || round.bets.length === 0) {
    if (channel) {
      await channel.send(`🎰 Roulette closed. Spin: **${spin.num} ${spin.color.toUpperCase()}** (no bets placed)`);
    }
    return;
  }

  const perUser = new Map();
  for (const b of round.bets) {
    const payout = calcPayout(b, spin);
    const cur = perUser.get(b.userId) || { betTotal: 0, winTotal: 0, betCount: 0 };
    cur.betTotal += b.amount;
    cur.winTotal += payout;
    cur.betCount += 1;
    perUser.set(b.userId, cur);
  }

  // apply payouts
  for (const [uid, totals] of perUser.entries()) {
    ensureUser(uid);
    if (!data.seasonStats[uid]) data.seasonStats[uid] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };

    if (totals.winTotal > 0) {
      data.userStats[uid].xp += totals.winTotal;
      data.seasonStats[uid].seasonGambleWon += totals.winTotal;
    }
  }

  await saveData();

  if (channel) {
    let summary = `🎰 **ROULETTE RESULT**: **${spin.num} ${spin.color.toUpperCase()}**\n`;

    const results = [...perUser.entries()]
      .map(([uid, t]) => ({ uid, net: t.winTotal - t.betTotal, betTotal: t.betTotal, winTotal: t.winTotal }))
      .sort((a, b) => b.net - a.net);

    const lines = results.slice(0, 10).map((r, i) => {
      const sign = r.net >= 0 ? "+" : "";
      return `**${i + 1}.** <@${r.uid}> — net **${sign}${r.net} XP** (bet ${r.betTotal}, paid ${r.winTotal})`;
    });

    summary += `\n🏆 **Round net results:**\n${lines.join("\n")}`;
    await channel.send(summary);
  }
}

// =============================
// LEADERBOARDS (Season/Year)
// =============================
function topSeasonRips(limit = 10) {
  const entries = Object.entries(data.seasonStats || {});
  return entries
    .map(([uid, s]) => ({ uid, val: s.seasonRips || 0 }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

function topSeasonNet(limit = 10) {
  const entries = Object.keys(data.seasonStats || {});
  return entries
    .map((uid) => ({ uid, val: getSeasonNet(uid) }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

function topYearRips(limit = 10) {
  const entries = Object.entries(data.yearly?.totals || {});
  return entries
    .map(([uid, t]) => ({ uid, val: t.yearRips || 0 }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

function topYearNet(limit = 10) {
  const entries = Object.entries(data.yearly?.totals || {});
  return entries
    .map(([uid, t]) => ({ uid, val: t.yearGambleNet || 0 }))
    .sort((a, b) => b.val - a.val)
    .slice(0, limit);
}

// All-time top rippers
function topAllTimeRippers(limit = 10) {
  return Object.entries(data.userStats || {})
    .map(([uid, u]) => ({ uid, rips: u.allTimeRips || 0 }))
    .sort((a, b) => b.rips - a.rips)
    .slice(0, limit);
}

// =============================
// MUSIC (QUICK / UNSTABLE) — ENABLED BY FLAG
// =============================
let joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior;
let getVoiceConnection, entersState, VoiceConnectionStatus, StreamType;
let playdl;
let musicState;

function isMusicCommand(cmd) {
  return ["play","skip","stop","pause","resume","queue","leave","voicecheck"].includes(cmd);
}

if (ENABLE_MUSIC) {
  const ffmpegPath = require("ffmpeg-static");
  process.env.FFMPEG_PATH = ffmpegPath;

  ({
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    getVoiceConnection,
    entersState,
    VoiceConnectionStatus,
    StreamType
  } = require("@discordjs/voice"));

  playdl = require("play-dl");

  musicState = new Map(); // guildId -> { connection, player, queue: [{title,url}], playing: bool, textChannelId }

  function getGuildState(guildId) {
    if (!musicState.has(guildId)) {
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
      });

      const state = { connection: null, player, queue: [], playing: false, textChannelId: null };
      musicState.set(guildId, state);

      player.on(AudioPlayerStatus.Idle, async () => {
        state.playing = false;
        await playNext(guildId);
      });

      player.on("error", async (err) => {
        console.error("Audio player error:", err);
        state.playing = false;
        await playNext(guildId);
      });
    }
    return musicState.get(guildId);
  }

  async function connectToUserVC(msg) {
    const member = msg.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await msg.reply("🎧 You need to join a voice channel first.");
      return null;
    }

    const guildId = msg.guild.id;
    const state = getGuildState(guildId);
    state.textChannelId = msg.channel.id;

    const existing = getVoiceConnection(guildId);
    if (existing) {
      state.connection = existing;
      return state;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: msg.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    state.connection = connection;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (e) {
      console.error("Voice connect failed:", e);
      try { connection.destroy(); } catch {}
      state.connection = null;
      await msg.reply("❌ Couldn’t join voice. Check bot permissions + try again.");
      return null;
    }

    connection.subscribe(state.player);
    return state;
  }

  function looksLikeUrl(s) {
    return /^https?:\/\/\S+/i.test(s);
  }

  async function resolveTrack(query) {
    if (looksLikeUrl(query)) {
      try {
        const info = await playdl.video_basic_info(query).catch(() => null);
        if (info?.video_details?.title) return { title: info.video_details.title, url: query };
      } catch {}
      return { title: query, url: query };
    }

    const results = await playdl.search(query, { limit: 1 });
    if (!results || results.length === 0) return null;
    return { title: results[0].title || query, url: results[0].url };
  }

  async function playNext(guildId) {
    const state = getGuildState(guildId);
    if (state.playing) return;
    if (!state.connection) return;
    if (!state.queue.length) return;

    const next = state.queue.shift();
    state.playing = true;

    try {
      const stream = await playdl.stream(next.url, { quality: 2 });
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type === "opus" ? StreamType.OggOpus : StreamType.Arbitrary
      });

      state.player.play(resource);

      if (state.textChannelId) {
        const channel = client.channels.cache.get(state.textChannelId);
        if (channel) channel.send(`🎶 Now playing: **${next.title}**`);
      }
    } catch (e) {
      console.error("Play failed:", e);
      state.playing = false;

      if (state.textChannelId) {
        const channel = client.channels.cache.get(state.textChannelId);
        if (channel) channel.send("❌ That track failed (YouTube/SoundCloud sometimes blocks). Try another link/search.");
      }

      await playNext(guildId);
    }
  }

  global.__music = { getGuildState, connectToUserVC, resolveTrack, playNext };
}

// =============================
// COMMANDS LIST
// =============================
const COMMANDS = [
  { name: "!commands", desc: "Show all commands" },
  { name: "!help", desc: "Same as !commands" },
  { name: "!ping", desc: "Health check" },
  { name: "!version", desc: "Bot version" },
  { name: "!uptime", desc: "Show uptime" },

  { name: "!season", desc: "Season info (window + active)" },
  { name: "!seasonboard", desc: "Season leaderboards (rips + gambling net)" },
  { name: "!yearboard", desc: "Yearly leaderboards (sum of seasons)" },

  { name: "!ripstats", desc: "Your stats (XP, rips, day/week/month/year, streak, crit)" },
  { name: "!crit", desc: "Show your crit chance + add rates" },
  { name: "!mostrips", desc: "Top 3 single-day records (global)" },
  { name: "!toprippers", desc: "Top rippers (all-time)" },

  { name: "!red <bet>", desc: "Roulette bet on red" },
  { name: "!black <bet>", desc: "Roulette bet on black" },
  { name: "!number <0-36|00> <bet>", desc: "Roulette bet on number" },
  { name: "!roulette", desc: "Roulette round status" },

  { name: "!toggleautoreply", desc: "Admin: toggle auto replies" },
  { name: "!addexp @user <amt>", desc: "Admin: add XP" },
  { name: "!addrips @user <amt>", desc: "Admin: add all-time rips" },

  { name: "!play <url|search>", desc: "Music (if ENABLE_MUSIC=true)" },
  { name: "!skip", desc: "Music skip" },
  { name: "!stop", desc: "Music stop + clear queue" },
  { name: "!pause", desc: "Music pause" },
  { name: "!resume", desc: "Music resume" },
  { name: "!queue", desc: "Music queue" },
  { name: "!leave", desc: "Music leave" },
  { name: "!voicecheck", desc: "Voice diagnostics" },
];

function formatCommands() {
  const lines = COMMANDS.map(c => `• \`${c.name}\` — ${c.desc}`);
  const musicLine = `\n\n🎵 Music: **${ENABLE_MUSIC ? "ENABLED" : "DISABLED"}**`;
  return `📜 **BongBot Commands**\n${lines.join("\n")}${musicLine}`;
}

// =============================
// READY
// =============================
client.on("ready", async () => {
  console.log(`🔥 BongBot 2.0 online as ${client.user.tag}`);

  // tick season updates every 10 min
  setInterval(async () => {
    try {
      await loadData();
      await maybeUpdateSeasonAndFinalizeIfNeeded();
    } catch (e) {
      console.error("season tick error:", e);
    }
  }, 10 * 60 * 1000);
});

// =============================
// MESSAGE HANDLER
// =============================
const lastAutoReplyAt = new Map();
const START_TIME = Date.now();

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    await loadData();

    const raw = msg.content.trim();
    const content = raw.toLowerCase();
    const userId = msg.author.id;

    ensureUser(userId);

    // ================
    // COMMANDS FIRST
    // (Commands NEVER count as rips)
    // ================
    if (content.startsWith("!")) {
      const parts = raw.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (cmd === "!ping") return msg.reply("pong ✅");
      if (cmd === "!version") return msg.reply(`BongBot ${BOT_VERSION}`);
      if (cmd === "!uptime") {
        const ms = Date.now() - START_TIME;
        const mins = Math.floor(ms / 60000);
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        return msg.reply(`⏱️ Uptime: **${hrs}h ${rem}m**`);
      }

      if (cmd === "!commands" || cmd === "!help") return msg.reply(formatCommands());

      if (cmd === "!toggleautoreply") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        data.settings.autoReplyEnabled = !data.settings.autoReplyEnabled;
        await saveData();
        return msg.reply(`Auto replies: **${data.settings.autoReplyEnabled ? "ON" : "OFF"}**`);
      }

      if (cmd === "!crit") {
        const a = data.activity[userId];
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
        const u = data.userStats[userId];
        const a = data.activity[userId];

        const s = data.seasonStats[userId] || { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
        const seasonNet = (s.seasonGambleWon || 0) - (s.seasonGambleBet || 0);

        return msg.reply(
          `👤 **Your Stats**\n` +
          `XP: **${u.xp}**\n` +
          `All-time rips: **${u.allTimeRips}**\n\n` +
          `📊 **Counts (Chicago time)**\n` +
          `Today: **${a.daily}** | Week: **${a.weekly}** | Month: **${a.monthly}** | Year: **${a.yearly}**\n` +
          `🔥 Streak: **${a.streak}**\n` +
          `🎯 Crit chance: **${(a.critChance * 100).toFixed(2)}%**\n\n` +
          `🏁 **Season (${data.season.id || "unknown"})**\n` +
          `Season active: **${data.season.active ? "YES ✅" : "NO ❌"}**\n` +
          `Season rips: **${s.seasonRips || 0}**\n` +
          `Season gambling net: **${seasonNet} XP**`
        );
      }

      if (cmd === "!mostrips") {
        const arr = data.highscores.topDaily || [];
        if (!arr.length) return msg.reply("🏆 No daily records yet.");
        const lines = arr.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.count}** on **${r.date}**`);
        return msg.reply(`🏆 **Most Rips In A Day (Top 3)**\n${lines.join("\n")}`);
      }

      if (cmd === "!toprippers") {
        const top = topAllTimeRippers(10);
        if (!top.length) return msg.reply("No rip data yet.");
        const lines = top.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.rips} rips**`);
        return msg.reply(`🏁 **Top Rippers (All-time)**\n${lines.join("\n")}`);
      }

      // ---- Season info ----
      if (cmd === "!season") {
        const s = data.season;
        return msg.reply(
          `🗓️ **Season Info (Chicago time)**\n` +
          `Season ID: **${s.id || "unknown"}**\n` +
          `Window: **${s.start || "?"}** → **${s.endExclusive || "?"}** (end is exclusive)\n` +
          `Active right now: **${s.active ? "YES ✅" : "NO ❌"}**`
        );
      }

      if (cmd === "!seasonboard") {
        const rip = topSeasonRips(10);
        const net = topSeasonNet(10);

        const ripLines = rip.length
          ? rip.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.val} rips**`).join("\n")
          : "_No season rips yet._";

        const netLines = net.length
          ? net.map((r, i) => {
              const sign = r.val >= 0 ? "+" : "";
              return `**${i + 1}.** <@${r.uid}> — **${sign}${r.val} net XP**`;
            }).join("\n")
          : "_No season gambling yet._";

        return msg.reply(
          `🏁 **Season Leaderboards** (Season: ${data.season.id})\n\n` +
          `💨 **Top Season Rips**\n${ripLines}\n\n` +
          `🎰 **Top Season Gambling Net XP**\n${netLines}`
        );
      }

      if (cmd === "!yearboard") {
        const yr = data.yearly?.year || new Date().getFullYear();
        const rip = topYearRips(10);
        const net = topYearNet(10);

        const ripLines = rip.length
          ? rip.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.val} rips**`).join("\n")
          : "_No yearly totals yet._";

        const netLines = net.length
          ? net.map((r, i) => {
              const sign = r.val >= 0 ? "+" : "";
              return `**${i + 1}.** <@${r.uid}> — **${sign}${r.val} net XP**`;
            }).join("\n")
          : "_No yearly gambling totals yet._";

        return msg.reply(
          `📅 **Yearly Leaderboards (${yr})**\n\n` +
          `💨 **Year Rips (sum of seasons)**\n${ripLines}\n\n` +
          `🎰 **Year Gambling Net XP (sum of seasons)**\n${netLines}`
        );
      }

      // ---- Admin restore ----
      if (cmd === "!addexp") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        const target = msg.mentions.users.first();
        const amt = parseInt(args[1], 10);
        if (!target || Number.isNaN(amt)) return msg.reply("Usage: `!addexp @user <amount>`");

        ensureUser(target.id);
        data.userStats[target.id].xp = Math.max(0, data.userStats[target.id].xp + amt);
        await saveData();
        return msg.reply(`✅ Added **${amt} XP** to <@${target.id}>. Now **${data.userStats[target.id].xp} XP**.`);
      }

      if (cmd === "!addrips") {
        if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
        const target = msg.mentions.users.first();
        const amt = parseInt(args[1], 10);
        if (!target || Number.isNaN(amt) || amt <= 0) return msg.reply("Usage: `!addrips @user <amount>`");

        ensureUser(target.id);
        data.userStats[target.id].allTimeRips += amt;
        await saveData();
        return msg.reply(`✅ Added **${amt} all-time rips** to <@${target.id}>.`);
      }

      // =============================
      // ROULETTE COMMANDS
      // =============================
      if (cmd === "!red") {
        const amt = parseInt(args[0], 10);
        if (Number.isNaN(amt)) return msg.reply("Usage: `!red <bet>`");
        const res = await placeBet({ userId, channelId: msg.channel.id, type: "red", pick: "red", amount: amt });
        return msg.reply(res.msg);
      }

      if (cmd === "!black") {
        const amt = parseInt(args[0], 10);
        if (Number.isNaN(amt)) return msg.reply("Usage: `!black <bet>`");
        const res = await placeBet({ userId, channelId: msg.channel.id, type: "black", pick: "black", amount: amt });
        return msg.reply(res.msg);
      }

      if (cmd === "!number") {
        const pickNum = (args[0] || "").toString();
        const amt = parseInt(args[1], 10);

        const validPick = pickNum === "00" || (/^\d+$/.test(pickNum) && Number(pickNum) >= 0 && Number(pickNum) <= 36);
        if (!validPick || Number.isNaN(amt)) return msg.reply("Usage: `!number <0-36|00> <bet>`");

        const res = await placeBet({ userId, channelId: msg.channel.id, type: "number", pick: pickNum, amount: amt });
        return msg.reply(res.msg);
      }

      if (cmd === "!roulette") {
        const round = await getRouletteRound();
        if (!round) return msg.reply("🎰 No active roulette round. Place a bet with `!red`, `!black`, or `!number`.");
        const secondsLeft = Math.max(0, Math.ceil((round.endTime - Date.now()) / 1000));
        return msg.reply(`🎰 Roulette is open — **${secondsLeft}s** left. Bets so far: **${round.bets.length}**`);
      }

      // =============================
      // MUSIC COMMANDS (only if enabled)
      // =============================
      if (!ENABLE_MUSIC && isMusicCommand(cmd.replace("!", ""))) {
        return msg.reply("🎵 Music is temporarily disabled. (Set `ENABLE_MUSIC=true` to enable.)");
      }

      if (ENABLE_MUSIC && cmd === "!voicecheck") {
        const vc = msg.member?.voice?.channel;
        const me = msg.guild?.members?.me;

        const lines = [];
        lines.push(`ENABLE_MUSIC: **true**`);
        lines.push(`FFMPEG_PATH set: **${process.env.FFMPEG_PATH ? "YES" : "NO"}**`);
        lines.push(`You in VC: **${vc ? vc.name : "NO"}**`);

        if (vc && me) {
          const perms = vc.permissionsFor(me);
          lines.push(`Bot can CONNECT: **${perms?.has(PermissionsBitField.Flags.Connect) ? "YES" : "NO"}**`);
          lines.push(`Bot can SPEAK: **${perms?.has(PermissionsBitField.Flags.Speak) ? "YES" : "NO"}**`);
        }

        return msg.reply("🔎 **VoiceCheck**\n" + lines.join("\n"));
      }

      if (ENABLE_MUSIC && cmd === "!play") {
        const query = raw.slice("!play".length).trim();
        if (!query) return msg.reply("Usage: `!play <youtube url | soundcloud url | search terms>`");

        const { connectToUserVC, resolveTrack, playNext } = global.__music;

        const state = await connectToUserVC(msg);
        if (!state) return;

        const track = await resolveTrack(query);
        if (!track) return msg.reply("❌ Couldn’t find anything for that search.");

        state.queue.push(track);
        await msg.reply(`✅ Queued: **${track.title}**`);

        if (!state.playing) await playNext(msg.guild.id);
        return;
      }

      if (ENABLE_MUSIC && cmd === "!skip") {
        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        if (!state.connection) return msg.reply("❌ I’m not in a voice channel.");
        state.player.stop(true);
        return msg.reply("⏭️ Skipped.");
      }

      if (ENABLE_MUSIC && cmd === "!stop") {
        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        state.queue = [];
        if (state.player) state.player.stop(true);
        return msg.reply("🛑 Stopped and cleared the queue.");
      }

      if (ENABLE_MUSIC && cmd === "!pause") {
        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        if (!state.player) return msg.reply("❌ Nothing playing.");
        state.player.pause();
        return msg.reply("⏸️ Paused.");
      }

      if (ENABLE_MUSIC && cmd === "!resume") {
        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        if (!state.player) return msg.reply("❌ Nothing playing.");
        state.player.unpause();
        return msg.reply("▶️ Resumed.");
      }

      if (ENABLE_MUSIC && cmd === "!queue") {
        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        if (!state.queue.length) return msg.reply("📭 Queue is empty.");
        const lines = state.queue.slice(0, 10).map((t, i) => `**${i + 1}.** ${t.title}`);
        return msg.reply(`📜 **Queue**\n${lines.join("\n")}`);
      }

      if (ENABLE_MUSIC && cmd === "!leave") {
        const conn = getVoiceConnection(msg.guild.id);
        if (conn) conn.destroy();

        const { getGuildState } = global.__music;
        const state = getGuildState(msg.guild.id);
        state.queue = [];
        state.playing = false;
        state.connection = null;

        return msg.reply("👋 Left voice and cleared the queue.");
      }

      // Unknown command: stop here so it never counts as a rip
      return;
    }

    // =============================
    // RIP + XP + CRITS (NON-COMMAND MESSAGES ONLY)
    // =============================
    const cat = detectCategory(content);
    if (!cat) return;

    const u = data.userStats[userId];
    const a = data.activity[userId];

    // reset per-day and update streak (Chicago)
    const today = chiDateStr(new Date());
    const wk = chiWeekKey(new Date());
    const mo = chiMonthKey(new Date());
    const yr = new Date().getFullYear();

    if (a.day !== today) {
      a.day = today;
      a.daily = 0;
      a.streak += 1;
      a.critChance = BASE_CRIT_START; // daily reset
    }
    if (a.weekKey !== wk) { a.weekKey = wk; a.weekly = 0; }
    if (a.monthKey !== mo) { a.monthKey = mo; a.monthly = 0; }
    if (a.year !== yr) { a.year = yr; a.yearly = 0; }

    a.daily += 1;
    a.weekly += 1;
    a.monthly += 1;
    a.yearly += 1;

    u.allTimeRips += 1;

    // Track global daily highscore
    updateTopDaily(today, userId, a.daily);

    // Season rips only count when season active
    if (data.season.active) {
      if (!data.seasonStats[userId]) data.seasonStats[userId] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
      data.seasonStats[userId].seasonRips += 1;
    }

    // Crit roll (ADD ONLY)
    const crit = rollCrit(a, cat.add);

    // XP payout
    let earned = cat.xp;
    if (crit.hit) {
      earned = (cat.type === "dab") ? CRIT_PAYOUT_DAB : CRIT_PAYOUT_GENERAL;
    }
    u.xp += earned;

    await saveData();

    // Auto reply (every message unless cooldown set)
    if (!data.settings.autoReplyEnabled) return;

    if (AUTO_REPLY_COOLDOWN_MS > 0) {
      const last = lastAutoReplyAt.get(userId) || 0;
      if (Date.now() - last < AUTO_REPLY_COOLDOWN_MS) return;
      lastAutoReplyAt.set(userId, Date.now());
    }

    const seasonLine = data.season.active
      ? `🏁 Season: **ACTIVE** | Season rips: **${data.seasonStats[userId]?.seasonRips || 0}**`
      : `🏁 Season: **INACTIVE** (rips still give XP + counts)`;

    return msg.reply(
      `✅ **${cat.variant.toUpperCase()} REGISTERED**\n` +
      `💸 +**${earned} XP** (Total: **${u.xp}**)\n` +
      `🎯 Crit used: **${(crit.used * 100).toFixed(2)}%** | Add: **+${(crit.addApplied * 100).toFixed(2)}%**\n` +
      (crit.hit ? `💥 **CRIT HIT!**\n` : "") +
      `📊 Today **${a.daily}** | Week **${a.weekly}** | Month **${a.monthly}** | Year **${a.yearly}** | Streak **${a.streak}**\n` +
      `${seasonLine}`
    );

  } catch (e) {
    console.error("messageCreate handler error:", e);
    try { await msg.reply("❌ Internal error (check Railway logs)."); } catch {}
  }
});

// =============================
// STARTUP
// =============================
(async () => {
  try {
    await redis.connect();
    await maybeWipeOnVersionBump();
    await loadData();

    // Ensure season state correct on boot
    await maybeUpdateSeasonAndFinalizeIfNeeded();

    // Ensure roulette timer resumes if round exists
    await ensureRouletteTimer();

    await client.login(process.env.BOT_TOKEN);
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();
