import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

const CONFIG_PATH = path.join(dataDir, 'config.json');

const DEFAULTS = {
  discordToken: '',
  voiceChannelId: '',
  twitchChannel: '',
  twitchUsername: '',
  twitchOauth: '',
  maxSongMinutes: 10,
  maxRequestsPerUser: 2,
  maxQueueSize: 0, // total songs allowed in the request queue (0 = no limit)
  queueFullMessage: 'the queue is full ({max} songs) — try again in a bit!',
  defaultVolume: 60,
  prefix: '!',
  dashboardPort: 4750,
  audioBitrate: 128, // opus encoder bitrate in kbps
  interruptFallback: true, // skip auto-playlist song instantly when a request arrives
  outputMode: 'discord', // 'discord' = play in Discord VC, 'browser' = play in the dashboard tab
};

function seedFromEnv() {
  // One-time migration for setups that used a .env file.
  const e = process.env;
  return {
    discordToken: e.DISCORD_TOKEN?.trim() || '',
    voiceChannelId: e.DISCORD_VOICE_CHANNEL_ID?.trim() || '',
    twitchChannel: e.TWITCH_CHANNEL?.trim() || '',
    twitchUsername: e.TWITCH_USERNAME?.trim() || '',
    twitchOauth: e.TWITCH_OAUTH?.trim() || '',
    maxSongMinutes: Number(e.MAX_SONG_MINUTES) || DEFAULTS.maxSongMinutes,
    maxRequestsPerUser: Number.isFinite(Number(e.MAX_REQUESTS_PER_USER))
      ? Number(e.MAX_REQUESTS_PER_USER)
      : DEFAULTS.maxRequestsPerUser,
    defaultVolume: Number(e.DEFAULT_VOLUME) || DEFAULTS.defaultVolume,
    prefix: e.COMMAND_PREFIX?.trim() || DEFAULTS.prefix,
  };
}

function sanitize(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  out.twitchChannel = String(out.twitchChannel || '').toLowerCase().replace(/^#/, '').trim();
  out.twitchUsername = String(out.twitchUsername || '').trim();
  out.twitchOauth = String(out.twitchOauth || '').trim();
  if (out.twitchOauth && !out.twitchOauth.startsWith('oauth:')) out.twitchOauth = 'oauth:' + out.twitchOauth;
  out.discordToken = String(out.discordToken || '').trim();
  out.voiceChannelId = String(out.voiceChannelId || '').trim();
  out.maxSongMinutes = Math.max(0, Number(out.maxSongMinutes) || 0);
  out.maxRequestsPerUser = Math.max(0, Number(out.maxRequestsPerUser) || 0);
  out.maxQueueSize = Math.max(0, Number(out.maxQueueSize) || 0);
  out.queueFullMessage = String(out.queueFullMessage || '').trim() || DEFAULTS.queueFullMessage;
  out.defaultVolume = Math.min(200, Math.max(1, Number(out.defaultVolume) || 60));
  out.prefix = String(out.prefix || '!').trim() || '!';
  out.dashboardPort = Math.min(65535, Math.max(1024, Number(out.dashboardPort) || 4750));
  out.audioBitrate = Math.min(320, Math.max(32, Number(out.audioBitrate) || 128));
  out.interruptFallback = out.interruptFallback !== false && out.interruptFallback !== 'false';
  out.outputMode = out.outputMode === 'browser' ? 'browser' : 'discord';
  return out;
}

export function loadConfig() {
  let cfg;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('[config] config.json is corrupted, starting from defaults:', err.message);
      cfg = {};
    }
  } else {
    cfg = seedFromEnv();
    if (cfg.discordToken || cfg.twitchChannel) {
      console.log('[config] imported settings from your old .env file into config.json');
    }
  }
  cfg = sanitize(cfg);
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const clean = sanitize(cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

export function isConfigured(cfg) {
  if (!cfg.twitchChannel) return false;
  if (cfg.outputMode === 'browser') return true; // Discord not needed in browser mode
  return Boolean(cfg.discordToken && cfg.voiceChannelId);
}
