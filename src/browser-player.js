import { downloadTrack } from './youtube.js';

/**
 * Plays songs through the dashboard tab instead of a Discord voice channel.
 * The server exposes the current song's audio file; the dashboard's <audio>
 * element plays it and reports back when it ends. Same queue/fallback/blacklist
 * behavior as the Discord player.
 */
export class BrowserPlayer {
  constructor(cfg) {
    this.mode = 'browser';
    this.queue = [];
    this.fallbackSongs = [];
    this.current = null;
    this.currentFile = null;
    this.volume = (cfg?.defaultVolume ?? 60) / 100;
    this.interruptFallback = cfg?.interruptFallback !== false;
    this.enabled = true;
    this.destroyed = false;
    this._paused = false;
    this._positionSec = null; // reported by the app window's audio element
    this._lastFallbackId = null;
    this._playToken = 0;
    this._downloading = false;
    this.onTrackStart = null;
    this.onChange = null;
  }

  get paused() {
    return this._paused;
  }

  enqueue(track) {
    track.source = 'request';
    this.queue.push(track);
    const pos = this.queue.length;
    this.onChange?.();
    if (!this.current) {
      this.playNext();
    } else if (this.current.source === 'fallback' && this.interruptFallback) {
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
      file = await downloadTrack(track);
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
    if (this.destroyed || token !== this._playToken) return;

    this.currentFile = file;
    this._paused = false;
    this._positionSec = 0;
    console.log(
      `[player] now playing in browser${track.source === 'fallback' ? ' (auto playlist)' : ''}: ${track.title} (${track.requestedBy})`
    );
    this.onChange?.();
    this.onTrackStart?.(track);
    this.prefetchNext();
  }

  prefetchNext() {
    const next = this.queue[0];
    if (next) downloadTrack(next).catch(() => {});
  }

  /** Called by the dashboard when its <audio> element finished the song. */
  ended(id) {
    if (this.current && this.current.id === id) {
      this.current = null;
      this.currentFile = null;
      this._positionSec = null;
      this.onChange?.();
      this.playNext();
    }
  }

  /** Called by the dashboard to report the audio element's playback position. */
  notePosition(id, sec) {
    if (this.current && this.current.id === id && Number.isFinite(sec)) {
      this._positionSec = Math.max(0, sec);
    }
  }

  skip() {
    const skipped = this.current;
    this._playToken++;
    this._downloading = false;
    this.current = null;
    this.currentFile = null;
    this.onChange?.();
    this.playNext();
    return skipped;
  }

  pause() {
    if (!this.current) return false;
    this._paused = true;
    this.onChange?.();
    return true;
  }

  resume() {
    if (!this.current) return false;
    this._paused = false;
    this.onChange?.();
    return true;
  }

  clear() {
    const n = this.queue.length;
    this.queue = [];
    this.onChange?.();
    return n;
  }

  setVolume(percent) {
    this.volume = Math.min(200, Math.max(1, percent)) / 100;
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

  destroy() {
    this.destroyed = true;
    this._playToken++;
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
      mode: 'browser',
      current: this.current ? strip(this.current) : null,
      queue: this.queue.map(strip),
      volume: Math.round(this.volume * 100),
      enabled: this.enabled,
      paused: this._paused,
      interruptFallback: this.interruptFallback,
      positionSec: this.current ? this._positionSec : null, // reported by the app window
    };
  }
}
