const fs = require("fs");
const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");

// =============================
// CONFIG
// =============================
const ALERT_CHANNEL_ID = "757698153494609943";

// XP + leveling
const XP_PER_RIP = 420;        // normal rip XP
const XP_DAB_RIP = 710;        // dab XP
const XP_EDDY_RIP = 840;       // eddys XP
const XP_JOINT_RIP = 840;      // joint XP
const XP_CRIT_RIP = 4269;      // crit XP (non-dab)
const XP_DAB_CRIT_RIP = 7100;  // crit dab XP

const XP_PER_LEVEL = 6969;
const MAX_LEVEL = 100;
const MAX_PRESTIGE = 10;

const BASE_CRIT_CHANCE = 0.01;
const CRIT_CHANCE_CAP = 1.0;
const DAB_CRIT_MULTIPLIER = 3;

// Trigger words
const RIP_VARIANTS = [
  // Bong-ish
  "bong rip", "bong rips", "bong ripz",
  "b0ng rip", "b0ng rips", "b0ng ripz",
  "b0nk rip", "b0nk rips", "b0nk ripz",
  "zong rip", "zong rips", "zong ripz",
  "z0ng rip", "z0ng rips", "z0ng ripz",
  "dong rip", "dong rips", "dong ripz",
  "d0ng rip", "d0ng rips", "d0ng ripz",
  "zonk rip", "zonk rips", "zonk ripz",
  "z0nk rip", "z0nk rips", "z0nk ripz",

  // Pen / smoke
  "pen rip", "pen rips", "pen rippers",
  "penjamin rip", "penjamin rips",
  "light up", "smoke", "smoke up",

  // Generic rip words
  "rip", "rips", "ripper", "rippers",
  "get high", "get high baby", "get high baby yeah",

  // Dabs
  "dabs", "dab rip", "dab rips", "fat dabs", "fat dabs for jesus",

  // Eddys
  "eddys",

  // Joints
  "joint", "doobie", "doink",
  "joint time", "doobie time",
  "smokin a doobie", "smokin a joint", "smokin a doink",
  "doink30", "joint30", "doobie30"
];

// =============================
// DISCORD CLIENT
// =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =============================
// STORAGE
// =============================
let data = {
  daily: 0,
  weekly: 0,
  monthly: 0,
  yearly: 0,
  lastDate: null,
  lastWeekStart: null,
  lastMonth: null,
  lastYear: null,
  highscores: [],
  userStats: {}
};

if (fs.existsSync("bongData.json")) {
  try {
    const file = JSON.parse(fs.readFileSync("bongData.json", "utf8"));
    data = { ...data, ...file };
    if (!data.userStats) data.userStats = {};
  } catch (err) {
    console.error("Error reading bongData.json, using defaults:", err);
  }
}

function save() {
  fs.writeFileSync("bongData.json", JSON.stringify(data, null, 2));
}

// =============================
// TIMEZONE HELPERS (FIXES RAILWAY UTC PROBLEM)
// =============================
// Gets hour/minute/day-of-week for a specific IANA timezone reliably.
function getZonedParts(timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  });

  const parts = dtf.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value;

  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);

  const weekday = get("weekday"); // "Mon", "Tue", ...
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekday] ?? null;

  return { hour, minute, dow };
}

// =============================
// RESET HELPERS
// =============================
function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentWeekStartString() {
  const now = new Date();
  const day = now.getDay(); // Sunday=0
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return sunday.toISOString().slice(0, 10);
}

function updateHighscores(date, count) {
  data.highscores.push({ date, count });
  data.highscores.sort((a, b) => b.count - a.count);
  data.highscores = data.highscores.slice(0, 3);
  save();
}

function checkResets() {
  const now = new Date();
  const today = getTodayString();
  const weekStart = getCurrentWeekStartString();

  // Daily + highscores
  if (data.lastDate !== today) {
    if (data.lastDate && data.daily > 0) {
      updateHighscores(data.lastDate, data.daily);
    }
    data.daily = 0;
    data.lastDate = today;
  }

  // Weekly
  if (data.lastWeekStart !== weekStart) {
    data.weekly = 0;
    data.lastWeekStart = weekStart;
  }

  // Monthly
  if (data.lastMonth !== now.getMonth()) {
    data.monthly = 0;
    data.lastMonth = now.getMonth();
  }

  // Yearly
  if (data.lastYear !== now.getFullYear()) {
    data.yearly = 0;
    data.lastYear = now.getFullYear();
  }

  save();
}

// =============================
// RIP DETECTION
// =============================
function messageHasRip(content) {
  const txt = content.toLowerCase();

  const bongRegex = /\b(?:b|z|d)(?:o|0)(?:ng|nk)\s+rip[sz]?\b/;
  const ripRegex = /\brips?\b/;

  return (
    bongRegex.test(txt) ||
    ripRegex.test(txt) ||
    RIP_VARIANTS.some(t => txt.includes(t))
  );
}

function isDabRip(content) {
  const txt = content.toLowerCase();
  return ["dabs", "dab rip", "dab rips", "fat dabs", "fat dabs for jesus"].some(t => txt.includes(t));
}

function isEddyRip(content) {
  return content.toLowerCase().includes("eddys");
}

function isJointRip(content) {
  const txt = content.toLowerCase();
  return [
    "joint", "doobie", "doink",
    "joint time", "doobie time",
    "smokin a doobie", "smokin a joint", "smokin a doink",
    "doink30", "joint30", "doobie30"
  ].some(t => txt.includes(t));
}

function isBongishRip(content) {
  const txt = content.toLowerCase();
  return (
    /\b(?:b|z|d)(?:o|0)(?:ng|nk)\s+rip[sz]?\b/.test(txt) ||
    txt.includes("zonk rip") || txt.includes("zonk rips") || txt.includes("zonk ripz") ||
    txt.includes("z0nk rip") || txt.includes("z0nk rips") || txt.includes("z0nk ripz")
  );
}

function isPenRip(content) {
  const txt = content.toLowerCase();
  return txt.includes("pen rip") || txt.includes("pen rips") || txt.includes("pen rippers") || txt.includes("penjamin");
}

function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickCategoryPhrase(content) {
  const txt = content.toLowerCase();

  const bongPhrases = ["bong rip", "zong rip", "dong rip", "zonk rip", "gnarly bong rip"];
  const dabPhrases = ["dab rip", "fat dabs", "710 blast", "terpy dab"];
  const penPhrases = ["pen rip", "penjamin rip", "cart rip"];
  const eddyPhrases = ["eddys", "eddy rip"];
  const jointPhrases = ["joint", "doobie", "doink", "doobie time", "joint time"];
  const genericPhrases = ["rip", "big rip", "mega rip", "cosmic rip"];

  if (isDabRip(txt)) return randomElement(dabPhrases);
  if (isEddyRip(txt)) return randomElement(eddyPhrases);
  if (isJointRip(txt)) return randomElement(jointPhrases);
  if (isBongishRip(txt)) return randomElement(bongPhrases);
  if (isPenRip(txt)) return randomElement(penPhrases);
  return randomElement(genericPhrases);
}

// =============================
// USER STATS
// =============================
function ensureUser(userId) {
  if (!data.userStats[userId]) {
    data.userStats[userId] = {
      xp: 0,
      level: 1,
      totalRips: 0,
      lastRipDate: null,
      streak: 0,
      longestStreak: 0,
      prestige: 0,
      critChance: BASE_CRIT_CHANCE
    };
  } else {
    const u = data.userStats[userId];
    if (u.critChance == null) u.critChance = BASE_CRIT_CHANCE;
    if (u.streak == null) u.streak = 0;
    if (u.longestStreak == null) u.longestStreak = 0;
    if (u.prestige == null) u.prestige = 0;
    if (u.lastRipDate === undefined) u.lastRipDate = null;
  }
}

function calculateLevel(xp) {
  const raw = Math.floor(xp / XP_PER_LEVEL) + 1;
  return Math.max(1, Math.min(MAX_LEVEL, raw));
}

function isYesterday(dateStr, todayStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const t = new Date(todayStr);
  const diff = (t - d) / (1000 * 60 * 60 * 24);
  return diff >= 0.9 && diff <= 1.1;
}

function formatTopRippers(limit = 10) {
  const entries = Object.entries(data.userStats);
  if (!entries.length) return null;

  const sorted = entries
    .sort(([, a], [, b]) => b.totalRips - a.totalRips)
    .slice(0, limit);

  const lines = sorted.map(([id, stats], i) => {
    return `**${i + 1}.** <@${id}> — **${stats.totalRips} rips**, Lvl **${stats.level}**, P **${stats.prestige}**`;
  });

  return "🏆 **Top Rippers**\n" + lines.join("\n");
}

function isAdmin(member) {
  return !!member && member.permissions?.has(PermissionsBitField.Flags.Administrator);
}

// =============================
// READY
// =============================
client.on("ready", () => {
  console.log(`🔥 Bot online as ${client.user.tag}`);
  checkResets();

  // Timezone-correct 4:20 alerts (no more UTC nonsense)
  // We fire when EACH city hits 4:20 locally.
  setInterval(() => {
    const channel = client.channels.cache.get(ALERT_CHANNEL_ID);
    if (!channel) return;

    const cincinnati = getZonedParts("America/New_York");
    const iowaCity   = getZonedParts("America/Chicago");
    const denver     = getZonedParts("America/Denver");
    const la         = getZonedParts("America/Los_Angeles");

    // Cincinnati 4:20
    if (cincinnati.hour === 16 && cincinnati.minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN CINCINNATI — SPARK UP BOYS** 💨🔥");
    }

    // Iowa City 4:20 (+ Saturday leaderboard)
    if (iowaCity.hour === 16 && iowaCity.minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN IOWA CITY — BLESS UP** 💨🔥");

      // Saturday in Iowa City time
      if (iowaCity.dow === 6) {
        const board = formatTopRippers(10);
        channel.send(board || "🏆 No rippers logged yet. Fix that.");
      }
    }

    // Denver 4:20
    if (denver.hour === 16 && denver.minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN DENVER — TOKE TIME** 💨🔥");
    }

    // LA 4:20
    if (la.hour === 16 && la.minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN LOS ANGELES — STAY LIT** 💨🔥");
    }
  }, 60 * 1000);
});

// =============================
// MESSAGE HANDLER
// =============================
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  checkResets();

  const content = msg.content.toLowerCase().trim();
  const userId = msg.author.id;

  // ---------- COMMANDS ----------
  if (content === "!rips") {
    await msg.reply(
      `📊 **Global Rip Stats**\n` +
      `Today: **${data.daily}**\n` +
      `Week: **${data.weekly}**\n` +
      `Month: **${data.monthly}**\n` +
      `Year: **${data.yearly}**`
    );
    return;
  }

  if (content === "!ripstats") {
    ensureUser(userId);
    const u = data.userStats[userId];
    await msg.reply(
      `👤 **Your Rip Stats**\n` +
      `Rips: **${u.totalRips}**\n` +
      `XP: **${u.xp}**\n` +
      `Level: **${u.level}**\n` +
      `Prestige: **${u.prestige}**\n` +
      `Streak: **${u.streak}** (Longest: **${u.longestStreak}**)\n` +
      `Crit chance: **${(u.critChance * 100).toFixed(2)}%**`
    );
    return;
  }

  if (content === "!toprippers") {
    const board = formatTopRippers(10);
    await msg.reply(board || "🏆 No rippers logged yet.");
    return;
  }

  if (content === "!mostrips") {
    if (!data.highscores.length) {
      await msg.reply("🏆 No daily highscores yet.");
      return;
    }
    const lines = data.highscores.map((h, i) => `**${i + 1}.** ${h.date}: **${h.count}**`);
    await msg.reply("🏆 **Top 3 Rip Days Ever**\n" + lines.join("\n"));
    return;
  }

  // Manual prestige
  if (content === "!prestige") {
    ensureUser(userId);
    const u = data.userStats[userId];

    if (u.level < MAX_LEVEL) {
      await msg.reply(`⏳ You must be Level **${MAX_LEVEL}** to prestige. You're Level **${u.level}**.`);
      return;
    }
    if (u.prestige >= MAX_PRESTIGE) {
      await msg.reply("🚫 Max prestige reached (**10**). Absolute legend.");
      return;
    }

    u.prestige += 1;
    u.level = 1;
    u.xp = 0;
    u.critChance = BASE_CRIT_CHANCE;
    save();

    await msg.reply(`🌟 <@${userId}> prestiged to **${u.prestige}** and reset to Level 1.`);
    return;
  }

  // ✅ NEW: Admin-only add XP
  // Usage: !addexp @user 12345
  if (content.startsWith("!addexp")) {
    if (!isAdmin(msg.member)) {
      await msg.reply("🚫 Admins only.");
      return;
    }

    const target = msg.mentions.users.first();
    const parts = msg.content.trim().split(/\s+/);
    const amount = parseInt(parts[2], 10);

    if (!target || isNaN(amount)) {
      await msg.reply("Usage: `!addexp @user <amount>`");
      return;
    }

    ensureUser(target.id);
    const u = data.userStats[target.id];

    u.xp = Math.max(0, u.xp + amount);
    u.level = calculateLevel(u.xp);
    save();

    await msg.reply(`✅ Added **${amount} XP** to <@${target.id}>. Now **${u.xp} XP**, Level **${u.level}**.`);
    return;
  }

  // ✅ NEW: Admin-only add rips
  // Usage: !addrips @user 50
  if (content.startsWith("!addrips")) {
    if (!isAdmin(msg.member)) {
      await msg.reply("🚫 Admins only.");
      return;
    }

    const target = msg.mentions.users.first();
    const parts = msg.content.trim().split(/\s+/);
    const amount = parseInt(parts[2], 10);

    if (!target || isNaN(amount) || amount <= 0) {
      await msg.reply("Usage: `!addrips @user <amount>`");
      return;
    }

    ensureUser(target.id);
    const u = data.userStats[target.id];

    // Add to user total
    u.totalRips += amount;

    // Also add to current global counters (so your week/month/year totals line up)
    data.daily += amount;
    data.weekly += amount;
    data.monthly += amount;
    data.yearly += amount;

    save();

    await msg.reply(`✅ Added **${amount} rips** to <@${target.id}>. They now have **${u.totalRips}** total rips.`);
    return;
  }

  // Admin reset user
  if (content.startsWith("!resetuser")) {
    if (!isAdmin(msg.member)) {
      await msg.reply("🚫 Admins only.");
      return;
    }
    const target = msg.mentions.users.first();
    if (!target) {
      await msg.reply("Usage: `!resetuser @user`");
      return;
    }

    data.userStats[target.id] = {
      xp: 0,
      level: 1,
      totalRips: 0,
      lastRipDate: null,
      streak: 0,
      longestStreak: 0,
      prestige: 0,
      critChance: BASE_CRIT_CHANCE
    };
    save();

    await msg.reply(
      `🚨 **CHEATER ALERT** 🚨\n` +
      `<@${target.id}> got RESET. Back to **Level 1**, **0 XP**, **0 rips**.\n` +
      `Bro tried to speedrun the lungs. Not today.`
    );
    return;
  }

  // Admin set level
  if (content.startsWith("!setlevel")) {
    if (!isAdmin(msg.member)) {
      await msg.reply("🚫 Admins only.");
      return;
    }

    const target = msg.mentions.users.first();
    const parts = msg.content.trim().split(/\s+/);
    const lvl = parseInt(parts[2], 10);

    if (!target || isNaN(lvl)) {
      await msg.reply("Usage: `!setlevel @user <level>`");
      return;
    }

    const clamped = Math.max(1, Math.min(MAX_LEVEL, lvl));
    ensureUser(target.id);
    const u = data.userStats[target.id];

    u.level = clamped;
    u.xp = (clamped - 1) * XP_PER_LEVEL; // put them exactly at that level's base XP
    save();

    await msg.reply(`🔧 Set <@${target.id}> to Level **${clamped}** (${u.xp} XP).`);
    return;
  }

  // ---------- RIP DETECTION ----------
  if (messageHasRip(content)) {
    ensureUser(userId);
    const u = data.userStats[userId];
    const today = getTodayString();

    // Global counters
    data.daily++;
    data.weekly++;
    data.monthly++;
    data.yearly++;

    // Streak bonus (once per day)
    let streakBonusXP = 0;
    const firstRipToday = u.lastRipDate !== today;

    if (firstRipToday) {
      if (isYesterday(u.lastRipDate, today)) u.streak += 1;
      else u.streak = 1;

      u.longestStreak = Math.max(u.longestStreak, u.streak);
      u.lastRipDate = today;
      streakBonusXP = 420;
    }

    const dabRip = isDabRip(content);
    const eddyRip = isEddyRip(content);
    const jointRip = isJointRip(content);

    // crit roll (dabs have higher roll chance multiplier)
    const effectiveCritChance = Math.min(u.critChance * (dabRip ? DAB_CRIT_MULTIPLIER : 1), CRIT_CHANCE_CAP);
    const isCrit = Math.random() < effectiveCritChance;

    if (isCrit) u.critChance = BASE_CRIT_CHANCE;
    else u.critChance = Math.min(u.critChance * 3, CRIT_CHANCE_CAP);

    // XP calc
    let baseXP;
    if (isCrit && dabRip) baseXP = XP_DAB_CRIT_RIP;
    else if (isCrit) baseXP = XP_CRIT_RIP;
    else if (eddyRip) baseXP = XP_EDDY_RIP;
    else if (jointRip) baseXP = XP_JOINT_RIP;
    else if (dabRip) baseXP = XP_DAB_RIP;
    else baseXP = XP_PER_RIP;

    const gain = baseXP + streakBonusXP;

    u.totalRips += 1;
    u.xp += gain;

    u.level = calculateLevel(u.xp); // capped at 100
    save();

    const phrase = pickCategoryPhrase(content);

    const critText = isCrit
      ? (dabRip ? " (**CRITICAL DAB RIP 💥 7100 XP**)" : " (**CRITICAL RIP 💥**)")
      : "";

    const typeText =
      (!isCrit && dabRip) ? " (**DAB RIP 🔥 710 XP base**)" :
      (!isCrit && jointRip) ? " (**JOINT ROLL 🌀 840 XP base**)" :
      (!isCrit && eddyRip) ? " (**EDDYS 💫 840 XP base**)" :
      "";

    const streakText = u.streak > 1
      ? `🔥 Streak: **${u.streak}** (Longest: **${u.longestStreak}**)`
      : `🔥 Streak: **${u.streak}**`;

    const prestigeText = u.prestige > 0 ? ` | 🌟 Prestige: **${u.prestige}**` : "";

    await msg.reply(
      `💨 **${phrase} registered as a rip!**${critText}${typeText}\n` +
      `👤 You: **${u.totalRips} rips**, **${u.xp} XP**, Level **${u.level}** (+${gain})${prestigeText}\n` +
      `${streakText}\n` +
      `🎯 Crit chance now: **${(u.critChance * 100).toFixed(2)}%**\n` +
      `📈 Today: **${data.daily}** | Week: **${data.weekly}** | Month: **${data.monthly}** | Year: **${data.yearly}**`
    );
  }
});

// =============================
// LOGIN (Railway uses BOT_TOKEN variable)
// =============================
client.login(process.env.BOT_TOKEN);
