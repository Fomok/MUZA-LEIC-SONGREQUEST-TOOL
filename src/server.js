import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from './config.js';
import { resolveTrack } from './youtube.js';
import { recentLogs } from './logger.js';
import { playlist, blacklist } from './store.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function startServer(bot, getConfig, setConfig) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(rootDir, 'public')));
  app.get('/overlay', (req, res) => res.sendFile(path.join(rootDir, 'public', 'overlay.html')));

  const state = () => ({
    ...bot.snapshot(),
    config: getConfig(),
    playlist: playlist.items,
    blacklist: blacklist.items,
    interruptFallback: bot.player ? bot.player.interruptFallback : getConfig().interruptFallback,
    logs: recentLogs().slice(-100),
  });

  app.get('/api/state', (req, res) => res.json(state()));

  // Lightweight endpoint for the OBS overlay (and audio mirroring checks).
  app.get('/api/now', (req, res) => {
    const snap = bot.player?.snapshot() ?? { current: null, queue: [], paused: false };
    res.json({
      current: snap.current,
      next: snap.queue?.[0] ?? null,
      queueLength: snap.queue?.length ?? 0,
      paused: snap.paused ?? false,
      positionSec: snap.positionSec ?? null,
    });
  });

  app.post('/api/config', async (req, res) => {
    try {
      const cfg = saveConfig({ ...getConfig(), ...req.body });
      setConfig(cfg);
      await bot.start(cfg);
      res.json(state());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/start', async (req, res) => {
    await bot.start(getConfig());
    res.json(state());
  });

  app.post('/api/control', (req, res) => {
    const { action, value } = req.body || {};

    if (action === 'interruptFallback') {
      // Works even while the bot is stopped; persists without a restart.
      const cfg = saveConfig({ ...getConfig(), interruptFallback: Boolean(value) });
      setConfig(cfg);
      if (bot.player) bot.player.interruptFallback = cfg.interruptFallback;
      return res.json(state());
    }

    const p = bot.player;
    if (!p) return res.status(400).json({ error: 'Bot is not running.' });
    switch (action) {
      case 'skip':
        p.skip();
        break;
      case 'pause':
        p.pause();
        break;
      case 'resume':
        p.resume();
        break;
      case 'clear':
        p.clear();
        break;
      case 'volume':
        p.setVolume(Number(value));
        break;
      case 'enable':
        p.enabled = Boolean(value);
        break;
      case 'remove':
        p.removeAt(Number(value));
        break;
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
    res.json(state());
  });

  app.post('/api/request', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Empty request' });
    const p = bot.player;
    if (!p) return res.status(400).json({ error: 'Bot is not running.' });
    try {
      const track = await resolveTrack(query);
      if (blacklist.has(track.id)) throw new Error('That song is blacklisted.');
      if (track.isLive || track.durationSec == null) throw new Error('Livestreams cannot be queued.');
      track.requestedBy = 'Dashboard';
      const pos = p.enqueue(track);
      res.json({ ok: true, title: track.title, position: pos });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- auto playlist ----
  app.post('/api/playlist/add', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Empty request' });
    try {
      const track = await resolveTrack(query);
      if (blacklist.has(track.id)) throw new Error('That song is blacklisted.');
      if (track.isLive || track.durationSec == null) throw new Error('Livestreams cannot be added.');
      const added = playlist.add({ id: track.id, url: track.url, title: track.title, durationSec: track.durationSec });
      if (!added) throw new Error('That song is already in the playlist.');
      res.json({ ok: true, title: track.title });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/playlist/remove', (req, res) => {
    playlist.removeAt(Number(req.body?.index));
    res.json(state());
  });

  // ---- blacklist ----
  app.post('/api/blacklist/add', (req, res) => {
    const p = bot.player;
    let track = null;
    if (req.body?.current) {
      if (!p?.current) return res.status(400).json({ error: 'Nothing is playing.' });
      track = p.current;
    } else if (req.body?.queueIndex != null) {
      track = p?.queue[Number(req.body.queueIndex)];
      if (!track) return res.status(400).json({ error: 'Song not found in queue.' });
    } else if (req.body?.playlistIndex != null) {
      track = playlist.items[Number(req.body.playlistIndex)];
      if (!track) return res.status(400).json({ error: 'Song not found in playlist.' });
    }
    if (!track?.id) return res.status(400).json({ error: 'Nothing to blacklist.' });

    blacklist.add({ id: track.id, title: track.title });
    // Purge it everywhere.
    if (p) {
      for (let i = p.queue.length - 1; i >= 0; i--) if (p.queue[i].id === track.id) p.removeAt(i);
    }
    const plIdx = playlist.items.findIndex((t) => t.id === track.id);
    if (plIdx !== -1) playlist.removeAt(plIdx);
    if (p?.current?.id === track.id) p.skip();
    console.log(`[bot] blacklisted: ${track.title}`);
    res.json(state());
  });

  app.post('/api/blacklist/remove', (req, res) => {
    blacklist.removeAt(Number(req.body?.index));
    res.json(state());
  });

  // ---- browser player mode ----
  function sniffAudioType(file) {
    try {
      const buf = Buffer.alloc(12);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);
      if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
      if (buf.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
      if (buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
      if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    } catch {}
    return 'application/octet-stream';
  }

  app.get('/api/audio/:id', (req, res) => {
    const p = bot.player;
    if (!p?.currentFile || p.current?.id !== req.params.id) {
      return res.status(404).json({ error: 'Not the current song.' });
    }
    res.sendFile(path.resolve(p.currentFile), {
      headers: { 'Content-Type': sniffAudioType(p.currentFile), 'Cache-Control': 'no-store' },
    });
  });

  app.post('/api/browser/ended', (req, res) => {
    bot.player?.ended?.(String(req.body?.id || ''));
    res.json(state());
  });

  app.post('/api/browser/position', (req, res) => {
    bot.player?.notePosition?.(String(req.body?.id || ''), Number(req.body?.positionSec));
    res.json({ ok: true });
  });

  app.post('/api/shutdown', async (req, res) => {
    res.json({ ok: true });
    console.log('[bot] shutdown requested from dashboard.');
    await bot.stop();
    setTimeout(() => process.exit(0), 300);
  });

  const port = getConfig().dashboardPort || 4750;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`[dashboard] open http://localhost:${port}`);
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}
