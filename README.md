# Song Bot — Twitch song requests → Discord voice

Viewers type `!sr <song name or YouTube link>` in your **Twitch chat**, and the bot plays the song in a **Discord voice channel**. Comes with a control panel in your browser: edit all settings there, watch the live queue, add/remove/skip/blacklist songs, and keep an **auto playlist** that plays when no requests are waiting. The queue is saved to disk, so closing the app doesn't lose it.

## Discord VC vs Browser player

The big toggle at the top of the panel picks where the music plays:

- **🎧 Discord VC bot** — plays in the configured Discord voice channel (the classic mode).
- **🌐 Browser player** — plays directly in the dashboard tab through your speakers/headphones; Discord isn't used at all (no bot token needed for this mode). Keep the tab open — it *is* the player. If the browser blocks autoplay, click the "start audio" button once.

Twitch requests, queue, limits, auto playlist and blacklist work the same in both modes.

In Discord mode there's also a **🔊 mirror** checkbox: the same song plays through the dashboard tab's speakers *at the same time* as the Discord bot (kept in sync within a few seconds). Useful as a backup when Discord acts up, or to feed your stream from the tab's audio while friends keep hearing the bot in VC — mute whichever side you don't need.

## OBS "now playing" overlay

Add a **Browser Source** in OBS with URL `http://localhost:4750/overlay` (size ~480×140). It renders inside OBS — no extra window on your desktop. Transparent background, shows a card with the thumbnail, title and requester, fades out when nothing is playing, and updates by itself on song change.

## Auto playlist & blacklist

- **Auto playlist**: add songs to it in the panel. Whenever the request queue is empty the bot plays random songs from this list, so the stream is never silent. The *"requests interrupt instantly"* toggle decides what happens when a request comes in during an auto song: ON = the auto song is skipped immediately; OFF = it finishes first, then requests play.
- **Blacklist**: every song row (queue, now playing, auto playlist) has a ⛔ button. Blacklisted songs are removed everywhere and can't be requested again until you "allow" them back in the ⛔ Blacklist panel.

## Audio quality

The bot encodes at **128 kbps Opus** by default (adjustable up to 320 in Settings → "Audio quality"). Two things on the Discord side also matter: set the **voice channel bitrate** as high as your server allows (channel → Edit Channel → Overview → Bitrate, 96 kbps unboosted), and in your own Discord client make sure the bot's **user volume** (right-click the bot in the channel) is at 100%.

## Desktop app (installer)

The repo builds a real Windows app — its own window, tray icon, no console, no browser tab:

1. Push this folder to a GitHub repository (see below).
2. On GitHub: **Actions → Build Windows app → Run workflow**. After ~5 minutes, download **song-bot-windows** from the run's Artifacts — it contains `Song Bot Setup <version>.exe` (installer) and a portable `.exe` (no install needed).
3. The installed app keeps its data (settings, playlists, cache, log) in your user profile (`%APPDATA%/Song Bot`), so it's independent from this folder. Closing the window hides it to the tray; right-click the tray icon to quit.

To publish the repo from this folder (once, on the PC — install [git](https://git-scm.com) if needed):

```
git init
git add .
git commit -m "Song Bot"
```

Then create an empty repository on github.com (private is fine — Actions works) and follow its "push an existing repository" instructions (two commands). Your tokens are safe: `.gitignore` keeps `config.json` and all personal data out of the repo. Tagging a commit `v1.0.0` and pushing the tag also attaches the exes to a GitHub Release automatically.

## Quick start

1. Install **Node.js LTS** from https://nodejs.org (defaults are fine).
2. Double-click **`Song Bot.vbs`**.
   - First run shows a window installing dependencies (a few minutes), then the control panel opens in your browser. After that, it starts silently — **no console window**.
3. In the control panel, open **⚙️ Settings**, fill in the fields (see below), click **Save & restart**. Done.

To open the panel again later: `http://localhost:4750` in any browser (double-clicking `Song Bot.vbs` while it's running also just opens the panel). To stop the bot, click **⏻ Quit app** in the panel.

## Getting the values for Settings

**Discord bot token + inviting the bot** (one-time, ~5 min):

1. https://discord.com/developers/applications → **New Application** → name it (e.g. "Song Bot").
2. **Bot** tab → **Reset Token** → copy it. This is the *Discord bot token*. Keep it secret.
3. **OAuth2 → URL Generator**: scope **bot**; permissions **View Channels**, **Connect**, **Speak**. Open the generated URL and invite the bot to the Discord server.

**Discord voice channel ID:**

- In Discord: User Settings → Advanced → enable **Developer Mode**. Then right-click the voice channel → **Copy Channel ID**.

**Twitch channel:** just the channel name whose chat has the requests (lowercase).

**Twitch bot account + oauth token** *(optional — lets the bot reply in chat: "added to queue", "now playing")*:

- https://twitchtokengenerator.com → **Bot Chat Token** → log in as the account the bot should chat as → copy the ACCESS TOKEN into the oauth field (with or without the `oauth:` prefix, both work).

## Chat commands

**Everyone:** `!sr <link or song name>`, `!song`, `!queue`, `!wrongsong` (remove your own last request)

**Streamer + mods:** `!skip`, `!pause` / `!resume`, `!clear`, `!volume <1-200>`, `!sron` / `!sroff`
(mods and the streamer also bypass the length/per-user limits — limits are configurable in Settings)

Everything mod-level can also be done from the control panel.

## Giving it to a friend

Send them this folder (you can delete `node_modules`, `config.json`, `queue.json`, `playlist.json`, `blacklist.json`, `bot.log` first — `config.json` contains your tokens!). They install Node.js, double-click `Song Bot.vbs`, and fill in Settings — or you pre-fill `config.json` for them so they don't touch anything. Each separately running copy should use its own Discord bot application (making a second one is free and takes 2 minutes, steps above).

## Hearing it on stream

The bot plays audio **into the Discord voice channel**. Join that channel with your own Discord to hear it; to get it into OBS, capture Discord's audio (e.g. an *Application Audio Capture* source).

## Files the app creates

- `config.json` — your settings and tokens (secret!)
- `queue.json` — the saved request queue, restored on next start
- `playlist.json` — your auto playlist
- `blacklist.json` — blacklisted songs
- `cache/` — downloaded song audio (songs are fully downloaded before playing so the audio can't stutter; the folder cleans itself up, keeping the ~150 most recent)
- `bot.log` — log of the current run (also visible under 📜 Logs in the panel)

## Troubleshooting

- **Something's wrong and I can't tell what** — check 📜 Logs in the control panel, or run `start-debug.bat` to see a live console.
- **"could not find that song" for everything** — YouTube changed something; run `npm rebuild youtube-dl-exec` in this folder (updates the downloader), then restart.
- **Bot in the voice channel but no sound** — make sure it isn't server-muted (right-click the bot in the channel).
- **Audio stutters or the speed warps** — check the logs at startup: if you see "native opus encoder not installed", run `npm install` in this folder and restart.
- **Reads chat but doesn't reply** — Twitch bot account fields are empty or the token expired.
- **Panel doesn't open** — go to `http://localhost:4750` manually.
- Tokens are secrets: never show Settings or `config.json` on stream.
