require('dotenv').config();
const express  = require('express');
const connectDB    = require('./db');
const Admin        = require('./models/Admin');
const AuthorizedBot = require('./models/AuthorizedBot');
const { adminCache, botCache } = require('./cache');
const { seedAdmins } = require('./seed');

const PORT = Number(process.env.port || process.env.PORT || 3000);
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
app.use(express.json());

let pingCount = 0;
let lastPingAt = null;
let lastSelfPingAt = null;
let lastSelfPingOk = false;

app.get('/ping', (req, res) => {
  pingCount += 1;
  lastPingAt = new Date();
  res.set('Cache-Control', 'no-store');
  res.status(200).send('hello world');
});

app.get('/', (_req, res) => res.redirect('/stats'));

app.get('/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pingCount,
    lastPingAt: lastPingAt ? lastPingAt.toISOString() : null,
    lastSelfPingAt: lastSelfPingAt ? lastSelfPingAt.toISOString() : null,
    lastSelfPingOk,
    selfUrl: SELF_URL || null,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
  });
});

app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

let bot = null;

async function boot() {
  try {
    await connectDB();

    await seedAdmins();

    const admins = await Admin.find().lean();
    adminCache.set(admins);
    console.log(`Admin cache loaded: ${admins.length} admin(s)`);

    const bots = await AuthorizedBot.find().lean();
    botCache.set(bots);
    console.log(`Bot cache loaded: ${bots.length} bot(s)`);

    bot = require('./bot');

    const me = await bot.telegram.getMe();
    console.log(`Bot connected: @${me.username} (ID: ${me.id})`);

    try {
      const hookInfo = await bot.telegram.getWebhookInfo();
      if (hookInfo && hookInfo.url) {
        console.log(`[boot] Stale webhook found: ${hookInfo.url} — dropping it for long-poll`);
        await bot.telegram.deleteWebhook();
      }
    } catch (err) {
      console.warn('[boot] webhook cleanup skipped:', err.message);
    }

    await bot.telegram.setMyCommands([
      { command: 'start',  description: '💳 Start Payment / Admin Panel'  },
    ]);
    console.log('Bot commands registered.');

    process.once('SIGINT',  () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    bot.launch().catch((err) => {
      if (err?.message !== 'Aborted') console.error('[bot]', err);
    });
    console.log('[bot] long-poll launched — receiving updates');

    if (SELF_URL) {
      const doSelfPing = async () => {
        try {
          const res = await fetch(`${SELF_URL}/ping`, { cache: 'no-store' });
          lastSelfPingAt = new Date();
          lastSelfPingOk = res.ok && res.status === 200;
          if (!lastSelfPingOk) console.warn(`[keepalive] self-ping non-200 (status=${res.status})`);
          else console.log(`[keepalive] self-ping ok @${SELF_URL}/ping`);
        } catch (err) {
          lastSelfPingAt = new Date();
          lastSelfPingOk = false;
          console.warn('[keepalive] self-ping failed:', err.message);
        }
      };
      doSelfPing();
      setInterval(doSelfPing, KEEPALIVE_INTERVAL_MS);
    } else {
      console.warn('[keepalive] SELF_URL / RENDER_EXTERNAL_URL not set — skip self-ping');
    }
  } catch (err) {
    console.error('[boot error]', err.message);
    if (SELF_URL) {
      console.warn('[boot] will retry boot in 15s while keeping HTTP server alive…');
      setTimeout(boot, 15 * 1000);
    }
  }
}

boot();
