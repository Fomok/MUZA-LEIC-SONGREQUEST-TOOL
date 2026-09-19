import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

function makeListStore(filename) {
  const file = path.join(dataDir, filename);
  let items = [];
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.items)) items = data.items.filter((t) => t && t.id);
    }
  } catch (err) {
    console.error(`[store] could not read ${filename}:`, err.message);
  }

  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), items }, null, 2));
    } catch (err) {
      console.error(`[store] could not save ${filename}:`, err.message);
    }
  };

  return {
    items, // NOTE: mutated in place so live references stay valid
    save,
    has(id) {
      return items.some((t) => t.id === id);
    },
    add(entry) {
      if (!entry?.id || this.has(entry.id)) return false;
      items.push(entry);
      save();
      return true;
    },
    removeAt(index) {
      if (index < 0 || index >= items.length) return null;
      const [removed] = items.splice(index, 1);
      save();
      return removed;
    },
  };
}

/** Streamer's fallback playlist — plays randomly when the request queue is empty. */
export const playlist = makeListStore('playlist.json');

/** Blocked songs — can't be requested or added. */
export const blacklist = makeListStore('blacklist.json');
