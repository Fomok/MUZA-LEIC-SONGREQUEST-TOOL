import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { MusicPlayer } from './player.js';
import { BrowserPlayer } from './browser-player.js';
import { startTwitch } from './twitch.js';
import { isConfigured } from './config.js';
import { playlist } from './store.js';

const QUEUE_PATH = path.join(dataDir, 'queue.json');

function loadSavedQueue() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    if (!Array.isArray(data.queue)) return [];
    return data.queue.filter((t) => t && t.url && t.title).map((t) => ({ ...t, source: 'request' }));
  } catch {
    return [];
  }
}

export class Bot {
  constructor() {
    this.state = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this.status = { discord: 'not connected', twitch: 'not connected' };
    this.player = null;
    this.discord = null;
    this.twitch = null;
    this._pendingQueue = loadSavedQueue(); // restored from last run
    this._saveTimer = null;
    this._cfg = null;
    this._unhealthySince = null;
    // Watchdog: if the voice connection stays broken for 2 minutes, restart the bot.
    setInterval(() => this.checkHealth(), 60_000).unref?.();
  }

  checkHealth() {
    if (this.state !== 'running' || !this._cfg || this._cfg.outputMode === 'browser') return;
    const status = this.player?.connection?.state?.status;
    if (status === VoiceConnectionStatus.Ready) {
      this._unhealthySince = null;
      return;
    }
    this._unhealthySince ??= Date.now();
    if (Date.now() - this._unhealthySince > 120_000) {
      console.warn('[bot] voice connection unhealthy for 2 minutes — doing a full restart...');
      this._unhealthySince = null;
      this.start(this._cfg).catch((e) => console.error('[bot] watchdog restart failed:', e.message));
    }
  }

  saveQueue() {
    // Debounced write; unfinished current song goes back to the front.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const p = this.player;
        const queue = p
          ? [p.current, ...p.queue].filter((t) => t && t.source !== 'fallback')
          : this._pendingQueue;
        fs.writeFileSync(QUEUE_PATH, JSON.stringify({ savedAt: new Date().toISOString(), queue }, null, 2));
      } catch (err) {
        console.error('[bot] failed to save queue:', err.message);
      }
    }, 300);
  }

  async start(cfg) {
    if (this.state === 'starting') return;
    await this.stop(true);

    if (!isConfigured(cfg)) {
      this.state = 'stopped';
      this.error = null;
      return;
    }

    this.state = 'starting';
    this.error = null;
    this._cfg = cfg;
    this._unhealthySince = null;
    this.status = { discord: 'connecting...', twitch: 'waiting...' };

    let discord;
    let player;
    try {
      player = cfg.outputMode === 'browser' ? new BrowserPlayer(cfg) : new MusicPlayer(cfg);
      player.queue = this._pendingQueue;
      this._pendingQueue = [];
      player.fallbackSongs = playlist.items; // live reference — dashboard edits apply immediately
      player.onChange = () => this.saveQueue();

      if (cfg.outputMode === 'browser') {
        this.status.discord = 'browser player (Discord not used)';
        console.log('[bot] browser player mode — audio plays in the dashboard tab.');
        this.twitch = startTwitch(player, cfg, this.status);
        this.player = player;
        this.state = 'running';
        console.log(`[bot] ready — viewers can use ${cfg.prefix}sr <song> in Twitch chat.`);
        if (player.queue.length > 0) console.log(`[bot] restored ${player.queue.length} song(s) from the previous session.`);
        player.playNext();
        return;
      }

      discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord login timed out')), 30_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        discord.once('clientReady', done);
        discord.once('ready', done);
        discord.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      await discord.login(cfg.discordToken).catch((e) => {
        throw new Error('Discord login failed — check the bot token. (' + e.message + ')');
      });
      await ready;
      // Persistent handlers so later gateway errors are logged, not fatal.
      discord.on('error', (e) => console.error('[discord] client error:', e.message));
      discord.on('shardError', (e) => console.error('[discord] shard error:', e.message));
      this.status.discord = `logged in as ${discord.user.tag}`;
      console.log(`[discord] logged in as ${discord.user.tag}`);

      const channel = await discord.channels.fetch(cfg.voiceChannelId).catch(() => null);
      if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
        throw new Error('Voice channel not found — check the voice channel ID and that the bot is invited to that server.');
      }

      await player.connect(channel);
      this.status.discord = `in voice: ${channel.name} (${discord.user.tag})`;

      this.twitch = startTwitch(player, cfg, this.status);

      this.player = player;
      this.discord = discord;
      this.state = 'running';
      console.log(`[bot] ready — viewers can use ${cfg.prefix}sr <song> in Twitch chat.`);
      if (player.queue.length > 0) {
        console.log(`[bot] restored ${player.queue.length} song(s) from the previous session.`);
        player.playNext();
      }
    } catch (err) {
      this.error = err.message;
      this.state = 'error';
      this.status.discord = 'error';
      console.error('[bot] start failed:', err.message);
      // roll back whatever partially started
      if (player) {
        this._pendingQueue = [player.current, ...player.queue].filter((t) => t && t.source !== 'fallback');
        player.destroy();
      }
      try {
        await discord?.destroy();
      } catch {}
    }
  }

  async stop(silent = false) {
    if (this.player) {
      this._pendingQueue = [this.player.current, ...this.player.queue].filter((t) => t && t.source !== 'fallback');
      this.player.destroy();
      this.player = null;
    }
    if (this.twitch) {
      try {
        await this.twitch.disconnect();
      } catch {}
      this.twitch = null;
    }
    if (this.discord) {
      try {
        await this.discord.destroy();
      } catch {}
      this.discord = null;
    }
    this.saveQueue();
    if (this.state !== 'error' || !silent) this.state = 'stopped';
    if (!silent) {
      this.status = { discord: 'not connected', twitch: 'not connected' };
      console.log('[bot] stopped.');
    }
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      status: this.status,
      player: this.player
        ? this.player.snapshot()
        : { current: null, queue: this._pendingQueue, volume: null, enabled: true, paused: false },
    };
  }
}
