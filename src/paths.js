import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder the app's code lives in. */
export const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where config/queue/playlist/blacklist/cache/log live.
 * Running from the folder (npm start): next to the code, as always.
 * Running as the installed desktop app: the per-user data folder
 * (set via SONGBOT_DATA by electron/main.js), since Program Files
 * shouldn't be written to.
 */
export const dataDir = process.env.SONGBOT_DATA || projectRoot;
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {}
