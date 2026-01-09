const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const { createClient } = require("redis");

// Voice / Music (quick way; can break sometimes)
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  StreamType
} = require("@discordjs/voice");

const playdl = require("play-dl");

// =============================
// CONFIG
// =============================
const ALERT_CHANNEL_ID = "757698153494609943";

// Roulette
const ROULETTE_WINDOW_MS = 90 * 1000;
const MIN_BET = 420;

// =============================
// REDIS
// =============================
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

const DATA_KEY = "bongbot2:data";
const ROULETTE_KEY = "bongbot2:roulette";

// =============================
// DISCORD
// =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates // required for music
  ]
});

// =============================
// DATA MODEL
// =============================
let data = {
  userStats: {
    // [userId]: { xp, totalRipsAllTime }
  },

  season: {
    id: null,
    start: null,
    endExclusive: null,
    active: false
  },

  seasonStats: {
    // [userId]: { seasonRips, seasonGambleBet, seasonGambleWon }
  },

  yearly: {
    year: null,
    totals: {
      // [userId]: { yearRips, yearGambleNet }
    }
  }
};

async function loadData() {
  const raw = await redis.get(DATA_KEY);
  if (raw) data = JSON.parse(raw);
}

async function saveData() {
  await redis.set(DATA_KEY, JSON.stringify(data));
}

function ensureUser(userId) {
  if (!data.userStats[userId]) {
    data.userStats[userId] = { xp: 0, totalRipsAllTime: 0 };
  }
  if (!data.seasonStats[userId]) {
    data.seasonStats[userId] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
  }

  const y = new Date().getFullYear();
  if (!data.yearly.year) data.yearly.year = y;
  if (data.yearly.year !== y) {
    data.yearly = { year: y, totals: {} };
  }
  if (!data.yearly.totals[userId]) {
    data.yearly.totals[userId] = { yearRips: 0, yearGambleNet: 0 };
  }
}

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

// =============================
// SEASONS
// =============================
// This month special: January season starts Jan 9 for 7 days (9..15 inclusive)
// Every other month: first 7 days of the month (1..7)
function getSeasonWindowFor(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth(); // 0-based
  const monthStr = String(m + 1).padStart(2, "0");

  if (m === 0) {
    const start = `${y}-01-09`;
    const endExclusive = `${y}-01-16`;
    return { start, endExclusive, id: `${y}-01@${start}` };
  }

  const start = `${y}-${monthStr}-01`;
  const endExclusive = `${y}-${monthStr}-08`;
  return { start, endExclusive, id: `${y}-${monthStr}@${start}` };
}

function yyyyMmDd(dateObj = new Date()) {
  return dateObj.toISOString().slice(0, 10);
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
  const today = yyyyMmDd(new Date());
  const window = getSeasonWindowFor(new Date());
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
// RIP DETECTION (simple + broad)
// =============================
function messageHasRip(content) {
  const txt = content.toLowerCase();
  return (
    /\brips?\b/.test(txt) ||
    txt.includes("bong") ||
    txt.includes("dab") ||
    txt.includes("doobie") ||
    txt.includes("joint") ||
    txt.includes("doink") ||
    txt.includes("eddys") ||
    txt.includes("penjamin") ||
    txt.includes("pen rip") ||
    txt.includes("zong") ||
    txt.includes("zonk") ||
    txt.includes("dong")
  );
}

// =============================
// ROULETTE (American wheel)
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
// LEADERBOARDS
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

// =============================
// MUSIC (QUICK WAY)
// =============================
// In-memory per-guild queue (will reset if bot restarts; that's fine for "quick way")
const musicState = new Map(); // guildId -> { connection, player, queue: [{title,url}], playing: bool }

function getGuildState(guildId) {
  if (!musicState.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    const state = { connection: null, player, queue: [], playing: false, textChannelId: null };
    musicState.set(guildId, state);

    // when a track ends, play next
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

  // re-use existing connection if in same channel
  const existing = getVoiceConnection(guildId);
  if (existing) {
    state.connection = existing;
    return state;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guildId,
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
  // If URL: use it directly
  if (looksLikeUrl(query)) {
    // Try to get a nice title
    try {
      const info = await playdl.video_basic_info(query).catch(() => null);
      if (info?.video_details?.title) {
        return { title: info.video_details.title, url: query };
      }
    } catch {}
    return { title: query, url: query };
  }

  // Otherwise: search YouTube (quick)
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

    // announce now playing
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

    // try next
    await playNext(guildId);
  }
}

// =============================
// READY
// =============================
client.on("ready", async () => {
  await redis.connect();
  await loadData();

  await maybeUpdateSeasonAndFinalizeIfNeeded();
  await ensureRouletteTimer();

  console.log(`🔥 BongBot 2.0 online as ${client.user.tag}`);

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
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  await loadData();

  const raw = msg.content.trim();
  const content = raw.toLowerCase();
  const userId = msg.author.id;

  ensureUser(userId);

  // ---- Season info ----
  if (content === "!season") {
    const s = data.season;
    return msg.reply(
      `🗓️ **Season Info**\n` +
        `Season ID: **${s.id || "unknown"}**\n` +
        `Window: **${s.start || "?"}** → **${s.endExclusive || "?"}** (end is exclusive)\n` +
        `Active right now: **${s.active ? "YES ✅" : "NO ❌"}**`
    );
  }

  if (content === "!seasonboard") {
    const rip = topSeasonRips(10);
    const net = topSeasonNet(10);

    const ripLines = rip.length
      ? rip.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.val} rips**`).join("\n")
      : "_No season rips yet._";

    const netLines = net.length
      ? net
          .map((r, i) => {
            const sign = r.val >= 0 ? "+" : "";
            return `**${i + 1}.** <@${r.uid}> — **${sign}${r.val} net XP**`;
          })
          .join("\n")
      : "_No season gambling yet._";

    return msg.reply(
      `🏁 **Season Leaderboards** (Season: ${data.season.id})\n\n` +
        `💨 **Top Season Rips**\n${ripLines}\n\n` +
        `🎰 **Top Season Gambling Net XP**\n${netLines}`
    );
  }

  if (content === "!yearboard") {
    const yr = data.yearly?.year || new Date().getFullYear();
    const rip = topYearRips(10);
    const net = topYearNet(10);

    const ripLines = rip.length
      ? rip.map((r, i) => `**${i + 1}.** <@${r.uid}> — **${r.val} rips**`).join("\n")
      : "_No yearly totals yet._";

    const netLines = net.length
      ? net
          .map((r, i) => {
            const sign = r.val >= 0 ? "+" : "";
            return `**${i + 1}.** <@${r.uid}> — **${sign}${r.val} net XP**`;
          })
          .join("\n")
      : "_No yearly gambling totals yet._";

    return msg.reply(
      `📅 **Yearly Leaderboards (${yr})**\n\n` +
        `💨 **Year Rips (sum of seasons)**\n${ripLines}\n\n` +
        `🎰 **Year Gambling Net XP (sum of seasons)**\n${netLines}`
    );
  }

  // ---- Personal stats ----
  if (content === "!ripstats") {
    const u = data.userStats[userId];
    const s = data.seasonStats[userId] || { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
    const net = (s.seasonGambleWon || 0) - (s.seasonGambleBet || 0);

    return msg.reply(
      `👤 **Your Stats**\n` +
        `XP: **${u.xp}**\n` +
        `All-time rips: **${u.totalRipsAllTime}**\n\n` +
        `🏁 **This Season (${data.season.id})**\n` +
        `Season rips: **${s.seasonRips || 0}**\n` +
        `Season gambling net: **${net} XP**`
    );
  }

  // ---- Admin restore ----
  if (content.startsWith("!addexp")) {
    if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
    const target = msg.mentions.users.first();
    const parts = raw.split(/\s+/);
    const amt = parseInt(parts[2], 10);
    if (!target || isNaN(amt)) return msg.reply("Usage: `!addexp @user <amount>`");

    ensureUser(target.id);
    data.userStats[target.id].xp = Math.max(0, data.userStats[target.id].xp + amt);
    await saveData();
    return msg.reply(`✅ Added **${amt} XP** to <@${target.id}>. Now **${data.userStats[target.id].xp} XP**.`);
  }

  if (content.startsWith("!addrips")) {
    if (!isAdmin(msg.member)) return msg.reply("🚫 Admins only.");
    const target = msg.mentions.users.first();
    const parts = raw.split(/\s+/);
    const amt = parseInt(parts[2], 10);
    if (!target || isNaN(amt) || amt <= 0) return msg.reply("Usage: `!addrips @user <amount>`");

    ensureUser(target.id);
    data.userStats[target.id].totalRipsAllTime += amt;
    await saveData();
    return msg.reply(`✅ Added **${amt} total rips** to <@${target.id}>.`);
  }

  // =============================
  // ROULETTE
  // =============================
  if (content.startsWith("!red ")) {
    const parts = raw.split(/\s+/);
    const amt = parseInt(parts[1], 10);
    if (isNaN(amt)) return msg.reply("Usage: `!red <bet>`");

    const res = await placeBet({ userId, channelId: msg.channel.id, type: "red", pick: "red", amount: amt });
    await saveData();
    return msg.reply(res.msg);
  }

  if (content.startsWith("!black ")) {
    const parts = raw.split(/\s+/);
    const amt = parseInt(parts[1], 10);
    if (isNaN(amt)) return msg.reply("Usage: `!black <bet>`");

    const res = await placeBet({ userId, channelId: msg.channel.id, type: "black", pick: "black", amount: amt });
    await saveData();
    return msg.reply(res.msg);
  }

  if (content.startsWith("!number ")) {
    const parts = raw.split(/\s+/);
    const pick = (parts[1] || "").toString();
    const amt = parseInt(parts[2], 10);

    const validPick = pick === "00" || (/^\d+$/.test(pick) && Number(pick) >= 0 && Number(pick) <= 36);
    if (!validPick || isNaN(amt)) return msg.reply("Usage: `!number <0-36|00> <bet>`");

    const res = await placeBet({ userId, channelId: msg.channel.id, type: "number", pick, amount: amt });
    await saveData();
    return msg.reply(res.msg);
  }

  if (content === "!roulette") {
    const round = await getRouletteRound();
    if (!round) return msg.reply("🎰 No active roulette round. Place a bet with `!red`, `!black`, or `!number`.");
    const secondsLeft = Math.max(0, Math.ceil((round.endTime - Date.now()) / 1000));
    return msg.reply(`🎰 Roulette is open — **${secondsLeft}s** left. Bets so far: **${round.bets.length}**`);
  }

  // =============================
  // MUSIC COMMANDS (Quick way)
  // =============================
  if (content.startsWith("!play ")) {
    const query = raw.slice("!play ".length).trim();
    if (!query) return msg.reply("Usage: `!play <youtube url | soundcloud url | search terms>`");

    const state = await connectToUserVC(msg);
    if (!state) return;

    const track = await resolveTrack(query);
    if (!track) return msg.reply("❌ Couldn’t find anything for that search.");

    state.queue.push(track);

    await msg.reply(`✅ Queued: **${track.title}**`);

    // start if idle
    if (!state.playing) await playNext(msg.guild.id);
    return;
  }

  if (content === "!skip") {
    const state = getGuildState(msg.guild.id);
    if (!state.connection) return msg.reply("❌ I’m not in a voice channel.");
    state.player.stop(true);
    return msg.reply("⏭️ Skipped.");
  }

  if (content === "!stop") {
    const state = getGuildState(msg.guild.id);
    state.queue = [];
    if (state.player) state.player.stop(true);
    return msg.reply("🛑 Stopped and cleared the queue.");
  }

  if (content === "!pause") {
    const state = getGuildState(msg.guild.id);
    if (!state.player) return msg.reply("❌ Nothing playing.");
    state.player.pause();
    return msg.reply("⏸️ Paused.");
  }

  if (content === "!resume") {
    const state = getGuildState(msg.guild.id);
    if (!state.player) return msg.reply("❌ Nothing playing.");
    state.player.unpause();
    return msg.reply("▶️ Resumed.");
  }

  if (content === "!queue") {
    const state = getGuildState(msg.guild.id);
    if (!state.queue.length) return msg.reply("📭 Queue is empty.");
    const lines = state.queue.slice(0, 10).map((t, i) => `**${i + 1}.** ${t.title}`);
    return msg.reply(`📜 **Queue**\n${lines.join("\n")}`);
  }

  if (content === "!leave") {
    const conn = getVoiceConnection(msg.guild.id);
    if (conn) conn.destroy();
    const state = getGuildState(msg.guild.id);
    state.queue = [];
    state.playing = false;
    state.connection = null;
    return msg.reply("👋 Left voice and cleared the queue.");
  }

  // =============================
  // RIP COUNTING (ONLY DURING SEASON)
  // =============================
  if (messageHasRip(content)) {
    data.userStats[userId].totalRipsAllTime += 1;

    if (data.season.active) {
      if (!data.seasonStats[userId]) data.seasonStats[userId] = { seasonRips: 0, seasonGambleBet: 0, seasonGambleWon: 0 };
      data.seasonStats[userId].seasonRips += 1;

      // No constant spam replies (keeps interest)
      await saveData();
      return;
    }

    await saveData();
    return;
  }

  await saveData();
});

// =============================
// LOGIN
// =============================
client.login(process.env.BOT_TOKEN);
