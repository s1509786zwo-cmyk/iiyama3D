const KEY = 'iiyama3d.save.v1';

const DEFAULT = {
  version: 1,
  difficulty: 'normal',
  lastMapId: null,
  runs: {},          // mapId -> { bestTime, bestDifficulty, completions }
  settings: { sensitivity: 1, invertY: false, volume: 0.6 },
  totals: { playSeconds: 0, runs: 0, escapes: 0 },
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class SaveStore {
  constructor() {
    this.data = this._read();
  }

  _read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return clone(DEFAULT);
      const parsed = JSON.parse(raw);
      return { ...clone(DEFAULT), ...parsed, settings: { ...DEFAULT.settings, ...(parsed.settings || {}) }, runs: parsed.runs || {} };
    } catch {
      return clone(DEFAULT);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage may be unavailable (private mode) - game still runs */
    }
  }

  get canContinue() {
    return Boolean(this.data.lastMapId);
  }

  setDifficulty(diff) {
    this.data.difficulty = diff;
    this.save();
  }

  setLastMap(mapId) {
    this.data.lastMapId = mapId;
    this.save();
  }

  recordRun({ mapId, difficulty, seconds, escaped, collected, total }) {
    const entry = this.data.runs[mapId] || { bestTime: null, bestDifficulty: null, completions: 0, attempts: 0 };
    entry.attempts = (entry.attempts || 0) + 1;
    if (escaped) {
      entry.completions = (entry.completions || 0) + 1;
      if (entry.bestTime === null || seconds < entry.bestTime) {
        entry.bestTime = seconds;
        entry.bestDifficulty = difficulty;
      }
      this.data.totals.escapes = (this.data.totals.escapes || 0) + 1;
    }
    entry.lastCollected = collected;
    entry.lastTotal = total;
    this.data.runs[mapId] = entry;
    this.data.totals.runs = (this.data.totals.runs || 0) + 1;
    this.data.totals.playSeconds = (this.data.totals.playSeconds || 0) + seconds;
    this.save();
    return entry;
  }

  getRun(mapId) {
    return this.data.runs[mapId] || null;
  }

  reset() {
    this.data = clone(DEFAULT);
    this.save();
  }
}
