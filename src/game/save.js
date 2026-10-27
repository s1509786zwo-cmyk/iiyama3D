// Save data (localStorage). Keeps the existing save/retry flow simple and failure-safe.
const KEY = 'iiyama3d.save.v2';

const EMPTY = {
  version: 2,
  lastMapId: null,
  lastDifficulty: 'normal',
  best: {},           // mapId -> { survivedSeconds, cleared }
  totalRuns: 0,
  updatedAt: null,
};

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, best: {} };
    const data = JSON.parse(raw);
    if (!data || data.version !== 2) return { ...EMPTY, best: {} };
    return { ...EMPTY, ...data, best: data.best || {} };
  } catch {
    return { ...EMPTY, best: {} };
  }
}

export function writeSave(patch) {
  const cur = loadSave();
  const next = { ...cur, ...patch, best: { ...cur.best, ...(patch.best || {}) }, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage may be disabled - the game still runs */
  }
  return next;
}

export function recordRun({ mapId, difficulty, survivedSeconds, cleared }) {
  const cur = loadSave();
  const prev = cur.best[mapId] || { survivedSeconds: 0, cleared: false };
  const best = {
    survivedSeconds: Math.max(prev.survivedSeconds || 0, survivedSeconds),
    cleared: Boolean(prev.cleared || cleared),
  };
  return writeSave({
    lastMapId: mapId,
    lastDifficulty: difficulty,
    totalRuns: (cur.totalRuns || 0) + 1,
    best: { [mapId]: best },
  });
}
