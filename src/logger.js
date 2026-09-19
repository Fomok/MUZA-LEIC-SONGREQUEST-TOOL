import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

const LOG_PATH = path.join(dataDir, 'bot.log');

const ring = [];
const MAX_LINES = 300;

function stamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function push(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
    .join(' ');
  const line = `${stamp()} ${level} ${text}`;
  ring.push(line);
  if (ring.length > MAX_LINES) ring.shift();
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

export function initLogger() {
  try {
    fs.writeFileSync(LOG_PATH, `Song Bot log — started ${new Date().toLocaleString()}\n`);
  } catch {}
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => {
    orig.log(...a);
    push('INFO', a);
  };
  console.warn = (...a) => {
    orig.warn(...a);
    push('WARN', a);
  };
  console.error = (...a) => {
    orig.error(...a);
    push('ERROR', a);
  };
}

export function recentLogs() {
  return ring;
}
