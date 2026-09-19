import tmi from 'tmi.js';
import { resolveTrack, formatDuration } from './youtube.js';
import { blacklist } from './store.js';

export function startTwitch(player, cfg, status) {
  const identity =
    cfg.twitchUsername && cfg.twitchOauth
      ? { username: cfg.twitchUsername, password: cfg.twitchOauth }
      : undefined; // anonymous read-only connection

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity,
    channels: [cfg.twitchChannel],
  });

  const canReply = Boolean(identity);
  const say = (msg) => {
    if (canReply) client.say(cfg.twitchChannel, msg).catch(() => {});
    else console.log(`[chat-reply suppressed] ${msg}`);
  };

  // Announce new tracks in chat
  player.onTrackStart = (track) => {
    say(`🎵 Now playing: ${track.title} [${formatDuration(track.durationSec)}] — requested by @${track.requestedBy}`);
  };

  client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    const prefix = cfg.prefix;
    if (!message.startsWith(prefix)) return;

    const [rawCmd, ...rest] = message.slice(prefix.length).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const args = rest.join(' ').trim();
    const user = tags['display-name'] || tags.username;
    const isPrivileged = Boolean(tags.badges?.broadcaster) || tags.mod === true;

    try {
      switch (cmd) {
        case 'sr':
        case 'songrequest': {
          if (!player.enabled) return say(`@${user} song requests are currently off.`);
          if (!args) return say(`@${user} usage: ${prefix}sr <YouTube link or song name>`);

          if (cfg.maxQueueSize > 0 && !isPrivileged && player.queue.length >= cfg.maxQueueSize) {
            return say(`@${user} ` + cfg.queueFullMessage.replaceAll('{max}', cfg.maxQueueSize));
          }

          if (
            cfg.maxRequestsPerUser > 0 &&
            !isPrivileged &&
            player.countFor(user) >= cfg.maxRequestsPerUser
          ) {
            return say(`@${user} you already have ${cfg.maxRequestsPerUser} songs in the queue — wait for one to play.`);
          }

          let track;
          try {
            track = await resolveTrack(args);
          } catch (err) {
            return say(`@${user} ${err.message}`);
          }

          if (blacklist.has(track.id)) {
            return say(`@${user} that song is blacklisted.`);
          }
          if (track.isLive || track.durationSec == null) {
            return say(`@${user} livestreams can't be queued.`);
          }
          if (
            cfg.maxSongMinutes > 0 &&
            !isPrivileged &&
            track.durationSec > cfg.maxSongMinutes * 60
          ) {
            return say(`@${user} that song is too long (max ${cfg.maxSongMinutes} min).`);
          }

          track.requestedBy = user;
          const pos = player.enqueue(track);
          if (player.current === track) return; // "now playing" announce covers it
          return say(`@${user} added: ${track.title} [${formatDuration(track.durationSec)}] — position #${pos}`);
        }

        case 'song':
        case 'currentsong': {
          const c = player.current;
          return say(c ? `🎵 Current song: ${c.title} — requested by @${c.requestedBy}` : 'Nothing is playing right now.');
        }

        case 'queue': {
          if (!player.current && player.queue.length === 0) return say('The queue is empty.');
          const next = player.queue
            .slice(0, 3)
            .map((t, i) => `#${i + 1} ${t.title} (@${t.requestedBy})`)
            .join(' | ');
          const more = player.queue.length > 3 ? ` … +${player.queue.length - 3} more` : '';
          return say(`Up next: ${next || 'nothing'}${more}`);
        }

        case 'wrongsong': {
          const removed = player.removeLastFrom(user);
          return say(removed ? `@${user} removed your request: ${removed.title}` : `@${user} you have no songs in the queue.`);
        }

        // ---- streamer / mod only ----
        case 'skip': {
          if (!isPrivileged) return;
          const skipped = player.skip();
          return say(skipped ? `⏭ Skipped: ${skipped.title}` : 'Nothing to skip.');
        }

        case 'pause': {
          if (!isPrivileged) return;
          return player.pause() ? say('⏸ Paused.') : undefined;
        }

        case 'resume': {
          if (!isPrivileged) return;
          return player.resume() ? say('▶ Resumed.') : undefined;
        }

        case 'clear': {
          if (!isPrivileged) return;
          const n = player.clear();
          return say(`🗑 Cleared ${n} song(s) from the queue.`);
        }

        case 'volume': {
          if (!isPrivileged) return;
          const v = parseInt(args, 10);
          if (!Number.isFinite(v)) return say(`Current volume: ${Math.round(player.volume * 100)}%`);
          return say(`🔊 Volume set to ${player.setVolume(v)}%`);
        }

        case 'sron': {
          if (!isPrivileged) return;
          player.enabled = true;
          return say('Song requests are ON.');
        }

        case 'sroff': {
          if (!isPrivileged) return;
          player.enabled = false;
          return say('Song requests are OFF.');
        }
      }
    } catch (err) {
      console.error('[twitch] command error:', err);
    }
  });

  client.on('connected', () => {
    status.twitch = canReply ? `connected as ${cfg.twitchUsername}` : 'connected (read-only)';
    console.log(
      `[twitch] connected to #${cfg.twitchChannel}` +
        (canReply ? ` as ${cfg.twitchUsername}` : ' (read-only — set the Twitch bot account fields in Settings to enable chat replies)')
    );
  });

  client.on('disconnected', (reason) => {
    status.twitch = `disconnected (${reason || 'connection lost'})`;
  });

  client.connect().catch((err) => {
    const msg = String(err?.message || err);
    status.twitch = /login|authentication/i.test(msg)
      ? 'error: Twitch login failed — check the bot username & oauth token'
      : `error: ${msg}`;
    console.error('[twitch] failed to connect:', msg);
  });

  return client;
}
