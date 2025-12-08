const fs = require("fs");
const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");

// =============================
// 420 ALERT CHANNEL
// =============================
const ALERT_CHANNEL_ID = "757698153494609943"; // your 420 channel ID

// All the fun ways to say a "rip"
const RIP_VARIANTS = [
  // Bong / Zong / Dong / Zonk style
  "bong rip", "bong rips", "bong ripz",
  "b0ng rip", "b0ng rips", "b0ng ripz",
  "b0nk rip", "b0nk rips", "b0nk ripz",
  "zong rip", "zong rips", "zong ripz",
  "z0ng rip", "z0ng rips", "z0ng ripz",
  "dong rip", "dong rips", "dong ripz",
  "d0ng rip", "d0ng rips", "d0ng ripz",
  "zonk rip", "zonk rips", "zonk ripz",
  "z0nk rip", "z0nk rips", "z0nk ripz",

  // Pen / penjamin / smoke phrases
  "pen rip", "pen rips", "pen rippers",
  "penjamin rip", "penjamin rips",
  "light up", "smoke", "smoke up",

  // Extra rip terms
  "ripper",
  "rippers",
  "get high",
  "get high baby",
  "get high baby yeah",

  // Dab variants
  "dabs",
  "dab rip",
  "dab rips",
  "fat dabs",
  "fat dabs for jesus",

  // Eddy variant
  "eddys"
];

const XP_PER_RIP = 420;        // normal rip XP (includes pen, bong, etc.)
const XP_DAB_RIP = 710;        // dab XP
const XP_EDDY_RIP = 840;       // eddys XP
const XP_CRIT_RIP = 4269;      // critical rip XP
const XP_PER_LEVEL = 6969;
const MAX_LEVEL = 100;
const MAX_PRESTIGE = 10;

const BASE_CRIT_CHANCE = 0.01;       // 1% base crit chance
const CRIT_CHANCE_CAP = 1.0;         // cap at 100%
const DAB_CRIT_MULTIPLIER = 3;       // dabs get 3x crit chance per roll (for the check)

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let data = {
  daily: 0,
  weekly: 0,
  monthly: 0,
  yearly: 0,
  lastDate: null,
  lastWeekStart: null,
  lastMonth: null,
  lastYear: null,
  highscores: [],   // top 3 global days (by total rips)
  userStats: {}     // { userId: { xp, level, totalRips, lastRipDate, streak, longestStreak, prestige, critChance } }
};

// Load saved data if it exists
if (fs.existsSync("bongData.json")) {
  try {
    const file = JSON.parse(fs.readFileSync("bongData.json"));
    data = { ...data, ...file };
    if (!data.userStats) data.userStats = {};
  } catch (err) {
    console.log("Error reading bongData.json, using defaults:", err);
  }
}

function save() {
  fs.writeFileSync("bongData.json", JSON.stringify(data, null, 2));
}

function getToday() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
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
  const today = getToday();
  const weekStart = getWeekStart();

  // Daily + highscores
  if (data.lastDate !== today) {
    if (data.lastDate && data.daily > 0) {
      updateHighscores(data.lastDate, data.daily);
    }
    data.daily = 0;
    data.lastDate = today;
  }

  // Weekly (Sun–Sat)
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

// Detect whether a message should count as a "rip"
function messageHasRip(content) {
  const txt = content.toLowerCase();

  // bong / zong / dong style rips
  const bongRegex = /\b(?:b|z|d)(?:o|0)(?:ng|nk)\s+rip[sz]?\b/;

  // extra trigger phrases
  const extraTriggers = [
    "zonk rip", "zonk rips", "zonk ripz",
    "z0nk rip", "z0nk rips", "z0nk ripz",
    "pen rip", "pen rips", "pen rippers",
    "penjamin rip", "penjamin rips",
    "light up", "smoke", "smoke up",
    "ripper",
    "rippers",
    "get high",
    "get high baby",
    "get high baby yeah",
    "dabs",
    "dab rip",
    "dab rips",
    "fat dabs",
    "fat dabs for jesus",
    "eddys"
  ];

  return bongRegex.test(txt) || extraTriggers.some(t => txt.includes(t));
}

function isDabRip(content) {
  const txt = content.toLowerCase();
  const dabTriggers = [
    "dabs",
    "dab rip",
    "dab rips",
    "fat dabs",
    "fat dabs for jesus"
  ];
  return dabTriggers.some(t => txt.includes(t));
}

function isEddyRip(content) {
  const txt = content.toLowerCase();
  return txt.includes("eddys");
}

function isBongishRip(content) {
  const txt = content.toLowerCase();
  return /\b(?:b|z|d)(?:o|0)(?:ng|nk)\s+rip[sz]?\b/.test(txt) ||
    txt.includes("zonk rip") || txt.includes("zonk rips") || txt.includes("zonk ripz") ||
    txt.includes("z0nk rip") || txt.includes("z0nk rips") || txt.includes("z0nk ripz");
}

function isPenRip(content) {
  const txt = content.toLowerCase();
  return txt.includes("pen rip") || txt.includes("pen rips") ||
         txt.includes("pen rippers") || txt.includes("penjamin");
}

function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickCategoryPhrase(content) {
  const txt = content.toLowerCase();

  const bongPhrases = [
    "bong rip", "zong rip", "dong rip", "zonk rip", "fat bong rip", "gnarly bong rip"
  ];
  const dabPhrases = [
    "dab rip", "fat dabs", "710 blast", "terpy dab"
  ];
  const penPhrases = [
    "pen rip", "penjamin rip", "cart rip"
  ];
  const eddyPhrases = [
    "eddys", "eddy rip"
  ];
  const genericPhrases = [
    "rip", "big rip", "mega rip", "cosmic rip"
  ];

  if (isDabRip(txt)) return randomElement(dabPhrases);
  if (isEddyRip(txt)) return randomElement(eddyPhrases);
  if (isBongishRip(txt)) return randomElement(bongPhrases);
  if (isPenRip(txt)) return randomElement(penPhrases);
  return randomElement(genericPhrases);
}

// User helpers
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
  return diff >= 0.9 && diff <= 1.1; // ~1 day
}

function formatTopRippers(limit = 5) {
  const entries = Object.entries(data.userStats);
  if (!entries.length) return null;

  const sorted = entries
    .sort(([, a], [, b]) => b.totalRips - a.totalRips)
    .slice(0, limit);

  const lines = sorted.map(([id, stats], i) => {
    return `**${i + 1}.** <@${id}> — **${stats.totalRips} rips**, Level **${stats.level}**, Prestige **${stats.prestige}** (${stats.xp} XP)`;
  });

  return "🏆 **Top Rippers**\n" + lines.join("\n");
}

function isAdmin(member) {
  return !!member && member.permissions?.has(PermissionsBitField.Flags.Administrator);
}

// --------------------------
// Bot events
// --------------------------
client.on("ready", () => {
  console.log(`🔥 Bot online as ${client.user.tag}`);
  checkResets();

  // 3:20, 4:20, 5:20, 6:20 city-based alerts + Saturday leaderboard at 4:20
  setInterval(() => {
    const now = new Date();
    const dow = now.getDay(); // 0 Sunday, 6 Saturday
    const hour = now.getHours();
    const minute = now.getMinutes();

    const channel = client.channels.cache.get(ALERT_CHANNEL_ID);
    if (!channel) return;

    // 3:20 — Cincinnati
    if (hour === 15 && minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN CINCINNATI — SPARK UP BOYS** 💨🔥");
    }

    // 4:20 — Iowa City + Saturday leaderboard
    if (hour === 16 && minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN IOWA CITY — BLESS UP** 💨🔥");

      // If it's Saturday (dow === 6), also post leaderboard
      if (dow === 6) {
        const board = formatTopRippers(10);
        if (board) {
          channel.send(board);
        } else {
          channel.send("🏆 No rippers yet this week. Tragic.");
        }
      }
    }

    // 5:20 — Denver
    if (hour === 17 && minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN DENVER — TOKE TIME** 💨🔥");
    }

    // 6:20 — Los Angeles
    if (hour === 18 && minute === 20) {
      channel.send("🔥💨 **IT'S 4:20 IN LOS ANGELES — STAY LIT** 💨🔥");
    }
  }, 60 * 1000); // check every minute
});

client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;

  checkResets();

  const content = msg.content.toLowerCase().trim();
  const userId = msg.author.id;

  // ---------- COMMANDS ----------
  if (content === "!rips") {
    msg.reply(
      `📊 **Global Rip Stats**\n` +
      `Today: **${data.daily} rips**\n` +
      `This week: **${data.weekly} rips**\n` +
      `This month: **${data.monthly} rips**\n` +
      `This year: **${data.yearly} rips**`
    );
    return;
  }

  if (content === "!ripstats") {
    ensureUser(userId);
    const user = data.userStats[userId];
    msg.reply(
      `👤 **Your Rip Stats**\n` +
      `Total rips: **${user.totalRips}**\n` +
      `XP: **${user.xp}**\n` +
      `Level: **${user.level}**\n` +
      `Prestige: **${user.prestige}**\n` +
      `Streak: **${user.streak} days** (Longest: **${user.longestStreak}**)\n` +
      `Critical chance: **${(user.critChance * 100).toFixed(2)}%**`
    );
    return;
  }

  if (content === "!toprippers") {
    const board = formatTopRippers(10);
    if (!board) {
      msg.reply("🏆 No rips logged yet. Shameful.");
      return;
    }
    msg.reply(board);
    return;
  }

  if (content === "!mostrips") {
    if (!data.highscores.length) {
      msg.reply("🏆 No daily rip highscores yet — keep ripping.");
      return;
    }

    const lines = data.highscores.map((h, i) =>
      `**${i + 1}.** ${h.date}: **${h.count} rips**`
    );
    msg.reply("🏆 **Top 3 Rip Days Ever**\n" + lines.join("\n"));
    return;
  }

  // Manual prestige
  if (content === "!prestige") {
    ensureUser(userId);
    const user = data.userStats[userId];

    if (user.level < MAX_LEVEL) {
      msg.reply(`⏳ You need to be Level **${MAX_LEVEL}** to prestige. You're only Level **${user.level}**.`);
      return;
    }
    if (user.prestige >= MAX_PRESTIGE) {
      msg.reply("🚫 You already hit max Prestige (**10**). Chill, boss.");
      return;
    }

    user.prestige += 1;
    user.level = 1;
    user.xp = 0;
    user.critChance = BASE_CRIT_CHANCE;
    save();

    msg.reply(
      `🌟 **PRESTIGE UNLOCKED!** <@${userId}> is now Prestige **${user.prestige}**, reset to Level 1.\n` +
      `You have ascended. Again.`
    );
    return;
  }

  // Admin-only: reset user
  if (content.startsWith("!resetuser")) {
    if (!isAdmin(msg.member)) {
      msg.reply("🚫 You don't have permission to use this command.");
      return;
    }

    const target = msg.mentions.users.first();
    if (!target) {
      msg.reply("Usage: `!resetuser @user`");
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

    msg.reply(
      `🚨 **CHEATER ALERT** 🚨\n` +
      `<@${target.id}> just got **HARD RESET** to Level 1, 0 XP, 0 rips.\n` +
      `Touch some grass, recalibrate your life, then come back and rip legit.`
    );
    return;
  }

  // Admin-only: set level
  if (content.startsWith("!setlevel")) {
    if (!isAdmin(msg.member)) {
      msg.reply("🚫 You don't have permission to use this command.");
      return;
    }

    const parts = content.split(/\s+/);
    const target = msg.mentions.users.first();
    if (!target || parts.length < 3) {
      msg.reply("Usage: `!setlevel @user <level>`");
      return;
    }

    const levelArg = parts[2];
    const level = parseInt(levelArg, 10);
    if (isNaN(level) || level < 1) {
      msg.reply("Level must be a positive number.");
      return;
    }

    const clampedLevel = Math.min(MAX_LEVEL, level);
    ensureUser(target.id);
    const user = data.userStats[target.id];

    user.level = clampedLevel;
    user.xp = (clampedLevel - 1) * XP_PER_LEVEL;
    save();

    msg.reply(
      `🔧 Set <@${target.id}>'s level to **${clampedLevel}** (${user.xp} XP).\n` +
      (clampedLevel === MAX_LEVEL ? "They're now at the edge of prestige..." : "")
    );
    return;
  }

  // ---------- RIP DETECTION ----------
  if (messageHasRip(content)) {
    ensureUser(userId);
    const user = data.userStats[userId];
    const today = getToday();

    // Global counters
    data.daily++;
    data.weekly++;
    data.monthly++;
    data.yearly++;

    // Daily streak logic (per user)
    let streakBonusXP = 0;
    const firstRipToday = user.lastRipDate !== today;

    if (firstRipToday) {
      if (isYesterday(user.lastRipDate, today)) {
        user.streak += 1;
      } else {
        user.streak = 1;
      }
      user.longestStreak = Math.max(user.longestStreak, user.streak);
      user.lastRipDate = today;

      // bonus 420 XP for each day on the streak
      streakBonusXP = 420;
    }

    // Determine type of rip
    const dabRip = isDabRip(content);
    const eddyRip = isEddyRip(content);

    // Critical rip logic with per-user scaling chance
    const effectiveCritChance = Math.min(
      user.critChance * (dabRip ? DAB_CRIT_MULTIPLIER : 1),
      CRIT_CHANCE_CAP
    );
    const isCrit = Math.random() < effectiveCritChance;

    if (isCrit) {
      // Reset crit chance on crit
      user.critChance = BASE_CRIT_CHANCE;
    } else {
      // Triple crit chance on every non-crit rip, capped at 100%
      user.critChance = Math.min(user.critChance * 3, CRIT_CHANCE_CAP);
    }

    // Base XP logic (crit overrides everything, then eddy, then dab, then normal)
    let baseXP;
    if (isCrit) {
      baseXP = XP_CRIT_RIP;
    } else if (eddyRip) {
      baseXP = XP_EDDY_RIP;
    } else if (dabRip) {
      baseXP = XP_DAB_RIP;
    } else {
      baseXP = XP_PER_RIP;
    }

    let totalGain = baseXP + streakBonusXP;
    user.totalRips += 1;
    user.xp += totalGain;

    // Level (no auto-prestige; capped at 100)
    const newLevel = calculateLevel(user.xp);
    user.level = newLevel;

    save();

    const phrase = pickCategoryPhrase(content);
    const critText = isCrit ? " (**CRITICAL RIP 💥**)" : "";
    const dabText = !isCrit && dabRip ? " (**DAB RIP 🔥 710 XP base**)" : "";
    const eddyText = !isCrit && eddyRip ? " (**EDDYS 💫 840 XP base**)" : "";
    const streakText = user.streak > 1
      ? `🔥 Streak: **${user.streak} days** (Longest: **${user.longestStreak}**)`
      : `🔥 Streak: **${user.streak} day**`;

    const prestigeText = user.prestige > 0
      ? `\n🌟 Prestige: **${user.prestige}**`
      : "";

    const bonusText = streakBonusXP
      ? ` (+${baseXP} base, +${streakBonusXP} streak bonus)`
      : ` (+${baseXP})`;

    msg.reply(
      `💨 **${phrase} registered as a rip!**${critText}${dabText}${eddyText}\n` +
      `👤 You: **${user.totalRips} rips**, **${user.xp} XP**, Level **${user.level}**${bonusText}\n` +
      `${streakText}\n` +
      `🎯 Crit chance now: **${(user.critChance * 100).toFixed(2)}%**\n` +
      `📈 Today: **${data.daily}** | This week: **${data.weekly}** | This month: **${data.monthly}** | This year: **${data.yearly}**` +
      prestigeText
    );

    return;
  }
});

// =============================
// PUT YOUR BOT TOKEN HERE
// =============================
client.login(process.env.MTQ0NjI1MjY3NjkyODI0NTk2NA.GXqW5d.M3T4mFgYB-luKWV-aoPHybYWzvJyhri78NxkHQ);
