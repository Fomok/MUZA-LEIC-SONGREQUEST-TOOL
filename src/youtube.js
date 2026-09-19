import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';
import youtubedl from 'youtube-dl-exec';

const cacheDir = path.join(dataDir, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });

// Force yt-dlp (Python) to emit UTF-8 on Windows — otherwise titles with
// Polish/accented characters arrive in the local codepage and turn into �.
const UTF8_ENV = { env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } };

const YT_URL_RE =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^ ]*v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;

/**
 * Turn a viewer's request text (YouTube URL or free-text search) into a track.
 * Returns { id, url, title, durationSec } or throws with a chat-friendly message.
 */
export async function resolveTrack(text) {
  const match = text.match(YT_URL_RE);
  const target = match ? `https://www.youtube.com/watch?v=${match[1]}` : `ytsearch1:${text}`;

  let out;
  try {
    out = await youtubedl(
      target,
      {
        print: '%(id)s\t%(title)s\t%(duration)s\t%(is_live)s',
        noPlaylist: true,
        skipDownload: true,
        quiet: true,
        noWarnings: true,
        defaultSearch: 'ytsearch',
      },
      UTF8_ENV
    );
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    if (/video unavailable|private video|removed/i.test(msg)) {
      throw new Error('that video is unavailable.');
    }
    if (/age.restricted|sign in to confirm/i.test(msg)) {
      throw new Error('that video is age-restricted, cannot play it.');
    }
    console.error('[youtube] resolve failed:', msg.split('\n').slice(-3).join(' '));
    throw new Error('could not find that song.');
  }

  const line = String(out).trim().split('\n')[0];
  if (!line) throw new Error('no results found.');

  const [id, title, duration, isLive] = line.split('\t');
  if (!id || id === 'NA') throw new Error('no results found.');

  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: title && title !== 'NA' ? title : 'Unknown title',
    durationSec: duration && duration !== 'NA' ? Math.round(Number(duration)) : null,
    isLive: isLive === 'True' || isLive === 'true',
  };
}

const inflight = new Map();

/**
 * Download a track's audio into the local cache (skips if already cached).
 * Playing from a local file instead of streaming prevents audio speed-warping
 * when the network or YouTube throttles mid-song.
 * Returns the file path.
 */
export function downloadTrack(track) {
  const file = path.join(cacheDir, `${track.id}.audio`);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const now = new Date();
      fs.utimesSync(file, now, now); // touch for LRU pruning
      return Promise.resolve(file);
    }
  } catch {}

  if (inflight.has(track.id)) return inflight.get(track.id);

  const p = youtubedl(
    track.url,
    {
      output: file,
      format: 'bestaudio[acodec=opus]/bestaudio/best',
      noPlaylist: true,
      quiet: true,
      noWarnings: true,
    },
    UTF8_ENV
  )
    .then(() => {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error('download produced no file');
      }
      return file;
    })
    .catch((err) => {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      const msg = String(err?.stderr || err?.message || err);
      console.error('[youtube] download failed:', msg.split('\n').slice(-3).join(' '));
      throw new Error('could not download that song.');
    })
    .finally(() => inflight.delete(track.id));

  inflight.set(track.id, p);
  return p;
}

/** Keep only the most recently used cached songs. */
export function pruneCache(maxFiles = 150) {
  try {
    const files = fs
      .readdirSync(cacheDir)
      .map((f) => {
        const full = path.join(cacheDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(maxFiles)) fs.rmSync(f.full, { force: true });
    if (files.length > maxFiles) console.log(`[cache] pruned ${files.length - maxFiles} old song file(s).`);
  } catch {}
}

export function formatDuration(sec) {
  if (sec == null) return '?:??';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
