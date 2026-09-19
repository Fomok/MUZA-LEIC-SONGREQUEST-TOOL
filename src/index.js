import { exec } from 'node:child_process';
import { initLogger } from './logger.js';
import { loadConfig, isConfigured } from './config.js';
import { Bot } from './bot.js';
import { startServer } from './server.js';
import { pruneCache, resolveTrack } from './youtube.js';
import { playlist } from './store.js';

initLogger();
pruneCache();

try {
  await import('@discordjs/opus');
  console.log('[audio] using native opus encoder.');
} catch {
  console.log('[audio] using ffmpeg opus encoder (same quality; volume changes restart the song at its position).');
}

let config = loadConfig();
const bot = new Bot();

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const embedded = Boolean(process.env.SONGBOT_EMBEDDED); // running inside the desktop app

export const appReady = (async () => {
  let port;
  try {
    ({ port } = await startServer(
      bot,
      () => config,
      (c) => (config = c)
    ));
    if (!embedded) openBrowser(`http://localhost:${port}`);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.log('[app] Song Bot is already running — opening the existing dashboard.');
      if (!embedded) openBrowser(`http://localhost:${config.dashboardPort || 4750}`);
      process.exit(0);
    }
    console.error('[app] could not start dashboard:', err.message);
    process.exit(1);
  }

  if (isConfigured(config)) {
    bot.start(config).catch((err) => console.error('[bot] start error:', err.message));
  } else {
    console.log('[app] not configured yet — fill in Settings in the dashboard.');
  }
  return { port, bot };
})();

// One-time repair: re-fetch playlist titles that were mangled by the old
// Windows codepage bug (they contain the � replacement character).
appReady.then(async () => {
  for (const item of playlist.items) {
    if (item.title && item.title.includes('�')) {
      try {
        const t = await resolveTrack(item.url);
        console.log(`[fix] repaired title: "${item.title}" -> "${t.title}"`);
        item.title = t.title;
        playlist.save();
      } catch {}
    }
  }
}).catch(() => {});

async function shutdown() {
  await bot.stop(true).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('[app] unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  // Log and keep running — the watchdog and reconnect logic recover the parts that broke.
  console.error('[app] uncaught exception:', err);
});
