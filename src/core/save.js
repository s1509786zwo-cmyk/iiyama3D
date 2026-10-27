/** Persistent progress / settings (localStorage). */
const KEY = 'iiyama3d.save.v2';

const DEFAULTS = {
  version: 2,
  settings: { sensitivity: 1.0, volume: 0.7, invertY: false },
  lastMapId: 'city_street',
  lastDifficulty: 'normal',
  records: {}, // `${mapId}/${difficulty}` -> { bestTime, escapes, attempts }
  stats: { plays: 0, escapes: 0, deaths: 0, fragments: 0 },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...clone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      stats: { ...DEFAULTS.stats, ...(parsed.stats || {}) },
      records: parsed.records || {},
    };
  } catch {
    return clone(DEFAULTS);
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch { /* storage may be unavailable */ }
  return save;
}

export function resetSave() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  return clone(DEFAULTS);
}

export const recordKey = (mapId, difficultyId) => `${mapId}/${difficultyId}`;

export function getRecord(save, mapId, difficultyId) {
  return save.records[recordKey(mapId, difficultyId)] || null;
}

/** store the outcome of a run; returns { record, isBest } */
export function commitRun(save, { mapId, difficultyId, escaped, time, fragments }) {
  const key = recordKey(mapId, difficultyId);
  const previous = save.records[key] || { bestTime: null, escapes: 0, attempts: 0 };
  const next = {
    bestTime: previous.bestTime,
    escapes: previous.escapes + (escaped ? 1 : 0),
    attempts: previous.attempts + 1,
    lastTime: time,
    lastFragments: fragments,
    updatedAt: Date.now(),
  };
  let isBest = false;
  if (escaped && (next.bestTime === null || time < next.bestTime)) {
    next.bestTime = time;
    isBest = true;
  }
  save.records[key] = next;
  save.stats.plays += 1;
  if (escaped) save.stats.escapes += 1;
  else save.stats.deaths += 1;
  save.stats.fragments += fragments;
  writeSave(save);
  return { record: next, isBest };
}

export function formatTime(seconds) {
  if (seconds === null || seconds === undefined) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
