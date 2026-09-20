import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { downloadTrack } from './youtube.js';

// Prefer the native opus encoder (live volume control); otherwise encode with
// ffmpeg, which needs no compiled add-ons and is just as good.
export const HAS_NATIVE_OPUS = await (async () => {
  try {
    await import('@discordjs/opus');
    return true;
  } catch {
    return false;
  }
})();

export class MusicPlayer {
  constructor(cfg) {
    this.queue = []; // viewer requests: { id, title, url, durationSec, requestedBy, source: 'request' }
    this.fallbackSongs = []; // live reference to the auto-playlist (set by bot)
    this.current = null;
    this.connection = null;
    this._playToken = 0;
    this._downloading = false;
    this.volume = (cfg?.defaultVolume ?? 60) / 100;
    this.audioBitrate = cfg?.audioBitrate ?? 128; // kbps
    this.interruptFallback = cfg?.interruptFallback !== false;
    this.enabled = true;
    this.destroyed = false;
    this._lastFallbackId = null;
    this.history = []; // recently finished/skipped tracks, newest last (max 10)
    this._noHistoryOnce = false;
    this.onTrackStart = null; // callback(track)
    this.onChange = null; // callback() — queue/current changed (used for persistence)

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      // Ignore stale events from a stream we killed while the next song downloads.
      if (this._downloading) return;
      if (this._seeking) return; // resource swap during a seek, not a real song end
      const ended = this.current;
      this.current = null;
      this.killFfmpeg();
      if (ended && !this._noHistoryOnce) this.pushHistory(ended);
      this._noHistoryOnce = false;
      this.onChange?.();
      this.playNext();
    });

    this.player.on('error', (err) => {
      // Errors from an old, already-replaced/killed stream must not skip the
      // song that is currently being prepared or played.
      if (err.resource && this.resource && err.resource !== this.resource) return;
      if (this._downloading) return;
      console.error('[player] playback error:', err.message);
      this.current = null;
      this.killFfmpeg();
      this.playNext();
    });
  }

  async connect(channel) {
    this.channel = channel;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;
      try {
        // Discord sometimes moves voice servers; give it a moment to resume on its own.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.scheduleReconnect(channel);
      }
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (!this.destroyed) this.scheduleReconnect(channel);
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.connection.subscribe(this.player);
    console.log(`[player] connected to voice channel: ${channel.name}`);
    // Kick off the auto playlist if there's nothing else to do.
    this.playNext();
  }

  /** Keep retrying the voice connection until it comes back (5s → 60s backoff). */
  scheduleReconnect(channel, attempt = 1) {
    if (this.destroyed || this._reconnecting) return;
    this._reconnecting = true;
    const delay = Math.min(60_000, 5_000 * attempt);
    console.warn(`[player] voice disconnected — rejoining in ${Math.round(delay / 1000)}s (attempt ${attempt})...`);
    setTimeout(async () => {
      if (this.destroyed) return;
      try {
        try {
          this.connection?.destroy();
        } catch {}
        await this.connect(channel);
        this._reconnecting = false;
        console.log('[player] voice reconnected.');
      } catch (err) {
        console.error('[player] rejoin failed:', err.message);
        this._reconnecting = false;
        this.scheduleReconnect(channel, attempt + 1);
      }
    }, delay);
  }

  destroy() {
    this.destroyed = true;
    this._playToken++;
    this.killFfmpeg();
    try {
      this.player.stop(true);
    } catch {}
    try {
      this.connection?.destroy();
    } catch {}
  }

  killFfmpeg() {
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill('SIGKILL');
      } catch {}
      this.ffmpeg = null;
    }
  }

  /** Add a viewer request; returns its position in the queue (1 = next up). */
  enqueue(track) {
    track.source = 'request';
    this.queue.push(track);
    const pos = this.queue.length;
    this.onChange?.();
    if (!this.current) {
      this.playNext();
    } else if (this.current.source === 'fallback' && this.interruptFallback) {
      // A real request arrived while an auto-playlist song was playing:
      // start its download first, then cut the auto song over to it.
      downloadTrack(track).catch(() => {});
      this.skip();
    } else {
      this.prefetchNext();
    }
    return pos;
  }

  pickFallback() {
    const list = this.fallbackSongs;
    if (!list || list.length === 0) return null;
    let pick = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1 && pick.id === this._lastFallbackId) {
      pick = list[Math.floor(Math.random() * list.length)];
    }
    this._lastFallbackId = pick.id;
    return { ...pick, requestedBy: 'Auto playlist', source: 'fallback' };
  }

  async playNext() {
    if (this.destroyed || this.current) return;
    let track = null;
    if (this.queue.length > 0) {
      track = this.queue.shift();
      track.source = 'request';
    } else {
      track = this.pickFallback();
    }
    if (!track) return;
    this.current = track;
    const token = ++this._playToken;
    this.onChange?.();

    let file;
    try {
      this._downloading = true;
      file = await downloadTrack(track); // instant when cached
    } catch (err) {
      this._downloading = false;
      console.error(`[player] skipping "${track.title}": ${err.message}`);
      if (token === this._playToken) {
        this.current = null;
        this.playNext();
      }
      return;
    }
    this._downloading = false;
    if (this.destroyed || token !== this._playToken) return; // skipped/stopped while downloading

    try {
      this._currentFile = file;
      this.currentFile = file; // exposed for browser mirroring / overlay
      this._startPlayback(file, 0);
      console.log(
        `[player] now playing${track.source === 'fallback' ? ' (auto playlist)' : ''}: ${track.title} (${track.requestedBy})`
      );
      this.onChange?.();
      this.onTrackStart?.(track);
      this.prefetchNext();
    } catch (err) {
      console.error('[player] failed to start track:', err);
      if (token === this._playToken) {
        this.current = null;
        this.playNext();
      }
    }
  }

  /** Start (or restart at an offset, for volume changes/seeking) playback of a local file. */
  _startPlayback(file, seekSec = 0) {
    let resource;
    if (HAS_NATIVE_OPUS && seekSec === 0) {
      resource = createAudioResource(file, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      resource.volume?.setVolume(this.volume);
      try {
        resource.encoder?.setBitrate(this.audioBitrate * 1000);
      } catch {}
    } else {
      // ffmpeg encodes straight to Ogg/Opus — no native encoder needed.
      this.killFfmpeg();
      const args = ['-hide_banner', '-loglevel', 'error'];
      if (seekSec > 0) args.push('-ss', seekSec.toFixed(2));
      args.push(
        '-i', file,
        '-vn',
        '-af', `volume=${this.volume.toFixed(3)}`,
        '-c:a', 'libopus',
        '-b:a', `${this.audioBitrate}k`,
        '-ar', '48000',
        '-ac', '2',
        '-f', 'ogg',
        'pipe:1'
      );
      this.ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      this.ffmpeg.on('error', (e) => console.error('[player] ffmpeg error:', e.message));
      resource = createAudioResource(this.ffmpeg.stdout, { inputType: StreamType.OggOpus });
    }
    this._seekOffset = seekSec;
    this.resource = resource;
    this.player.play(resource);
  }

  /** Download the next queued song in the background so it starts instantly. */
  prefetchNext() {
    const next = this.queue[0];
    if (next) downloadTrack(next).catch(() => {});
  }

  skip() {
    const skipped = this.current;
    if (this._downloading) {
      // Not playing yet — cancel the pending play and advance manually.
      this._playToken++;
      this._downloading = false;
      this.current = null;
      if (skipped && !this._noHistoryOnce) this.pushHistory(skipped);
      this._noHistoryOnce = false;
      this.onChange?.();
      this.playNext();
    } else {
      this.player.stop(true); // Idle handler advances the queue
    }
    return skipped;
  }

  pushHistory(t) {
    if (!t?.id) return;
    this.history.push({
      id: t.id,
      url: t.url,
      title: t.title,
      durationSec: t.durationSec,
      requestedBy: t.requestedBy,
      source: t.source,
    });
    if (this.history.length > 10) this.history.shift();
  }

  /** Replay the most recently finished/skipped song; the interrupted one resumes after it. */
  previous() {
    const prev = this.history.pop();
    if (!prev) return null;
    if (this.current) {
      this.queue.unshift({ ...this.current });
      this.queue.unshift({ ...prev });
      this._noHistoryOnce = true; // the interrupted song goes back to the queue, not history
      this.skip();
    } else {
      this.queue.unshift({ ...prev });
      this.onChange?.();
      this.playNext();
    }
    return prev;
  }

  /** Play a specific song immediately (from the auto playlist's "play now"). */
  playNow(item, by = 'Streamer') {
    const track = { ...item, requestedBy: by, source: 'request' };
    this.queue.unshift(track);
    this.onChange?.();
    if (this.current) this.skip();
    else this.playNext();
    return track;
  }

  /** Jump to a position (seconds) in the current song. */
  seek(sec) {
    if (!this.current || !this._currentFile) return false;
    const max = this.current.durationSec != null ? Math.max(0, this.current.durationSec - 2) : sec;
    const pos = Math.max(0, Math.min(Number(sec) || 0, max));
    try {
      this._seeking = true;
      this._startPlayback(this._currentFile, pos);
      return true;
    } catch (err) {
      console.error('[player] seek failed:', err.message);
      return false;
    } finally {
      setTimeout(() => (this._seeking = false), 500);
    }
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  get paused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  clear() {
    const n = this.queue.length;
    this.queue = [];
    this.onChange?.();
    return n;
  }

  setVolume(percent) {
    this.volume = Math.min(200, Math.max(1, percent)) / 100;
    if (this.resource?.volume) {
      this.resource.volume.setVolume(this.volume);
    } else if (this.current && this._currentFile && !this.paused) {
      // Restart the current song at its position so the new volume applies now.
      const elapsed = (this._seekOffset || 0) + (this.resource?.playbackDuration || 0) / 1000;
      try {
        this._startPlayback(this._currentFile, elapsed);
      } catch (err) {
        console.error('[player] volume restart failed:', err.message);
      }
    }
    return Math.round(this.volume * 100);
  }

  countFor(user) {
    return this.queue.filter((t) => t.requestedBy === user).length + (this.current?.requestedBy === user ? 1 : 0);
  }

  removeLastFrom(user) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].requestedBy === user) {
        const removed = this.queue.splice(i, 1)[0];
        this.onChange?.();
        return removed;
      }
    }
    return null;
  }

  removeAt(index) {
    if (index < 0 || index >= this.queue.length) return null;
    const removed = this.queue.splice(index, 1)[0];
    this.onChange?.();
    return removed;
  }

  snapshot() {
    const strip = (t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      durationSec: t.durationSec,
      requestedBy: t.requestedBy,
      source: t.source || 'request',
    });
    return {
      mode: 'discord',
      current: this.current ? strip(this.current) : null,
      queue: this.queue.map(strip),
      volume: Math.round(this.volume * 100),
      enabled: this.enabled,
      paused: this.paused,
      interruptFallback: this.interruptFallback,
      historyCount: this.history.length,
      positionSec: this.current
        ? Math.round(((this._seekOffset || 0) + (this.resource?.playbackDuration || 0) / 1000) * 10) / 10
        : null,
    };
  }
}
