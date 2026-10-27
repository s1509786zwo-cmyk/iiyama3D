import { GameApp, DIFFICULTIES } from './game/GameApp.js';
import { UI } from './ui/ui.js';
import { SaveStore } from './core/SaveStore.js';
import { AudioBus } from './core/Audio.js';
import { MapRegistry } from './maps/registry.js';
import { PreviewGenerator } from './maps/previews.js';

const canvas = document.getElementById('viewport');
const save = new SaveStore();
const audio = new AudioBus();
const registry = new MapRegistry();
const previews = new PreviewGenerator({ width: 512, height: 320 });

const app = new GameApp(canvas, { save, audio });
audio.setVolume(save.data.settings?.volume ?? 0.6);
app.sensitivity = save.data.settings?.sensitivity ?? 1;

const ui = new UI({ save, audio });

let difficultyId = save.data.difficulty || 'normal';
let selectedMapId = save.data.lastMapId || null;
let previewsRunning = false;
let previewsCancelled = false;
let previewPromise = Promise.resolve();

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
async function boot() {
  ui.renderDifficulty(difficultyId);
  ui.show('title');
  ui.setContinueVisible(Boolean(save.data.lastMapId));

  const maps = await registry.load();
  if (!maps.length) {
    ui.showError('マップ登録ファイル (maps/registry.json) を読み込めませんでした。');
    return;
  }
  ui.renderMaps(maps, selectedMapId);
  // Verify that every registered GLB actually exists and is a real glTF binary.
  await Promise.all(maps.map(async (m) => {
    await registry.probeAvailability(m);
    ui.updateMapCard(m);
  }));

  if (!selectedMapId || !maps.find((m) => m.id === selectedMapId)) {
    selectedMapId = maps.find((m) => m.status === 'ready')?.id || maps[0].id;
  }
  ui.setSelectedMap(selectedMapId, maps);
  previewPromise = (async () => {
    await Promise.all(maps.map(async (m) => {
      if (await tryStaticPreview(m)) ui.updateMapCard(m);
    }));
    await generatePreviews(maps);
  })();
}

/** Uses the committed preview image when present; otherwise renders one from the GLB. */
function tryStaticPreview(map) {
  if (!map.preview) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      map.previewUrl = new URL(map.preview, document.baseURI).href;
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = map.preview;
  });
}

async function generatePreviews(maps) {
  if (previewsRunning) return;
  previewsRunning = true;
  try {
    for (const map of maps) {
      if (previewsCancelled) break;
      if (map.previewUrl) continue;
      if (map.status === 'error') continue;
      map.previewState = 'generating';
      ui.updateMapCard(map);
      try {
        await previews.generate(map);
      } catch (err) {
        console.warn('[preview] failed for', map.id, err);
        map.previewState = 'failed';
      }
      map.previewState = map.previewUrl ? 'done' : 'failed';
      ui.updateMapCard(map);
      // Yield to keep the UI responsive between heavy models.
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally {
    previewsRunning = false;
  }
}

/* ------------------------------------------------------------------ *
 * Screen actions
 * ------------------------------------------------------------------ */
ui.callbacks.onDifficulty = (id) => {
  difficultyId = id;
  save.setDifficulty(id);
  ui.renderDifficulty(id);
};

ui.callbacks.onSelectMap = (id) => {
  selectedMapId = id;
  ui.setSelectedMap(id, registry.maps);
};

ui.callbacks.onAction = async (action) => {
  switch (action) {
    case 'to-difficulty': {
      const map = registry.maps.find((m) => m.id === selectedMapId);
      if (!map || map.status !== 'ready') {
        ui.showError(`「${map?.fileName || '未選択'}」を選択できません: ${map?.error || 'マップを選択してください'}`);
        break;
      }
      ui.renderDifficulty(difficultyId);
      ui.setDifficultyMapLabel(map.title);
      ui.show('difficulty');
      break;
    }
    case 'continue': {
      const maps = registry.maps;
      const map = maps.find((m) => m.id === save.data.lastMapId);
      if (map && map.status === 'ready') {
        selectedMapId = map.id;
        ui.setSelectedMap(map.id, maps);
        await startRun();
      } else {
        ui.show('mapselect');
      }
      break;
    }
    case 'help':
      ui.show('help');
      break;
    case 'back-title':
    case 'to-title':
      exitRun();
      ui.setContinueVisible(Boolean(save.data.lastMapId));
      ui.show('title');
      break;
    case 'to-mapselect':
      exitRun();
      ui.renderMaps(registry.maps, selectedMapId);
      registry.maps.forEach((m) => ui.updateMapCard(m));
      ui.setSelectedMap(selectedMapId, registry.maps);
      ui.show('mapselect');
      break;
    case 'start-run':
      await startRun();
      break;
    case 'retry-load':
      await startRun();
      break;
    case 'resume':
      ui.show('game');
      ui.setLockPrompt(false);
      app.resume();
      break;
    case 'restart':
      restartRun();
      break;
    default:
      break;
  }
};

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */
function exitRun() {
  previewsCancelled = false;
  app.input.exitLock();
  ui.setLockPrompt(false);
  if (app.state === 'playing' || app.state === 'paused' || app.state === 'ended' || app.state === 'loading') {
    app.unloadMap();
  }
  ui.show('title');
}

async function startRun() {
  const map = registry.maps.find((m) => m.id === selectedMapId);
  if (!map) return;
  if (map.status !== 'ready') {
    ui.showError(`「${map.fileName}」を読み込めません: ${map.error || map.status}`);
    return;
  }
  app.input.exitLock();
  ui.setLockPrompt(false);
  ui.showLoading(map);
  ui.currentMapFile = map.fileName;
  ui.setHudDifficulty(DIFFICULTIES[difficultyId]?.label || difficultyId);

  // Let any in-flight preview render finish so we do not double-load a GLB.
  previewsCancelled = true;
  await previewPromise;

  try {
    const info = await app.loadMap(map, {
      onProgress: (r) => ui.setLoadingProgress(r, r > 0.75 ? 'シーンを構築中 (衝突判定・開始地点)' : 'GLB を取得中'),
    });
    console.log('[map] loaded', map.id, info.stats, 'spawn', info.spawn.toArray(), 'source', info.spawnSource, 'cells', info.cells);
    ui.setLoadingProgress(1, '準備完了');
    app.start(difficultyId);
    save.setLastMap(map.id);
    save.save();
    ui.setContinueVisible(true);
    ui.show('game');
    ui.hideHudHint();
    ui.updateHud({ health: 100, stamina: 100, elapsed: 0, collected: 0, total: app.totalItems, exitActive: false, fps: 0, triangles: 0, mapTitle: map.title });
    await app.input.requestLock();
    if (!app.input.locked) ui.setLockPrompt(true);
    setTimeout(() => ui.hideHudHint(), 6000);
  } catch (err) {
    console.error('[map] load failed', err);
    map.status = 'error';
    map.error = err?.message || String(err);
    ui.updateMapCard(map);
    ui.showError(`${map.fileName} の読み込みに失敗しました: ${map.error}`);
  }
}

function restartRun() {
  if (!app.currentMap) return;
  app.restart();
  ui.show('game');
  ui.setLockPrompt(false);
  ui.hideHudHint();
  app.input.requestLock();
}

/* ------------------------------------------------------------------ *
 * Game <-> UI wiring
 * ------------------------------------------------------------------ */
app.onHud = (h) => ui.updateHud(h);

app.onEvent = (evt) => {
  switch (evt.type) {
    case 'pickup':
      ui.showToast(`記録 ${evt.collected} / ${evt.total} を回収`);
      break;
    case 'all-collected':
      ui.showToast('全記録を回収 — 脱出地点へ戻れ', 3000);
      break;
    case 'damage':
      ui.flashDamage();
      break;
    case 'pause-request':
      app.pause();
      ui.showPause(app.currentMap, difficultyId);
      break;
    case 'pointer-unlock':
      if (app.state === 'playing') ui.setLockPrompt(true);
      break;
    case 'escape':
    case 'die':
      ui.setLockPrompt(false);
      ui.showResult({
        escaped: evt.type === 'escape',
        elapsed: evt.elapsed,
        collected: evt.collected,
        total: evt.total,
        map: app.currentMap,
        difficulty: difficultyId,
        entry: evt.entry,
      });
      break;
    default:
      break;
  }
};

app.onLockChange = (locked) => {
  if (app.state === 'playing') ui.setLockPrompt(!locked);
};

document.getElementById('pointer-lock-prompt')?.addEventListener('click', () => {
  app.input.requestLock();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && app.state === 'playing') {
    app.pause();
    ui.showPause(app.currentMap, difficultyId);
  }
});

window.addEventListener('error', (e) => {
  console.error('Unhandled error', e.error || e.message);
});

/* ------------------------------------------------------------------ *
 * Debug / automation hooks (used by scripts/verify.mjs)
 * ------------------------------------------------------------------ */
window.__IIYAMA__ = {
  app,
  ui,
  registry,
  save,
  previews,
  get maps() { return registry.maps; },
  setDifficulty(id) {
    difficultyId = id;
    save.setDifficulty(id);
  },
  selectMap(id) {
    selectedMapId = id;
    ui.setSelectedMap(id, registry.maps);
  },
  async startRun(mapId, diff) {
    if (mapId) selectedMapId = mapId;
    if (diff) difficultyId = diff;
    await startRun();
    return app.describe();
  },
  async loadOnly(mapId, scaleOverride) {
    const map = registry.maps.find((m) => m.id === mapId);
    if (!map) throw new Error(`unknown map ${mapId}`);
    const copy = scaleOverride ? { ...map, scale: scaleOverride } : map;
    const info = await app.loadMap(copy, {});
    return { ...info, description: app.describe() };
  },
  ready: false,
};

boot()
  .then(() => {
    window.__IIYAMA__.ready = true;
    window.dispatchEvent(new Event('iiyama-ready'));
  })
  .catch((err) => {
    console.error('[boot] failed', err);
    ui.showError(err?.message || String(err));
  });
