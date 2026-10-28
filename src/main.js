import './style.css';
import { WebGLRenderer, SRGBColorSpace, ACESFilmicToneMapping } from 'three';
import { MAPS, DIFFICULTIES } from './maps/mapData.js';
import { loadSave } from './core/save.js';
import { Input } from './core/input.js';
import { resumeAudio, setVolume, sfx } from './core/audio.js';
import { GameSession } from './game/session.js';
import { renderTitle } from './ui/title.js';
import { renderMapSelect } from './ui/mapSelect.js';
import { renderDifficulty } from './ui/difficulty.js';
import { createHud } from './ui/hud.js';
import { showHelp, showCredits, showPause, showLoading, panelOverlay } from './ui/overlays.js';
import { el, button } from './ui/dom.js';

const canvas = document.getElementById('game-canvas');
const ui = document.getElementById('ui');
const toastRoot = document.getElementById('toast-root');

let renderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
} catch (error) {
  document.getElementById('ui').innerHTML = `
    <div class="screen loading-screen">
      <h2>WebGL を初期化できませんでした</h2>
      <p class="lead">このブラウザでは3D表示が利用できません。<br>
      ハードウェアアクセラレーションを有効にするか、別のブラウザで開いてください。</p>
      <p class="file">${String(error?.message || error)}</p>
    </div>`;
  throw error;
}

const save = loadSave();
setVolume(save.settings.volume);

const input = new Input(canvas);

const state = {
  screen: 'title',
  selectedMapId: save.lastMapId && MAPS.some((m) => m.id === save.lastMapId) ? save.lastMapId : MAPS[0]?.id,
  difficultyId: save.lastDifficulty || 'normal',
  session: null,
  hud: null,
  screenCleanup: null,
  overlay: null,
  starting: false,
  suppressLockPause: false,
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  if (state.session) state.session.resize(w, h);
}
window.addEventListener('resize', resize);

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  toastRoot.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, 2400);
}

function clearOverlay() {
  if (state.overlay) {
    state.overlay.remove();
    state.overlay = null;
  }
}

function setOverlay(node) {
  clearOverlay();
  state.overlay = node;
  ui.append(node);
  return node;
}

function runScreenCleanup() {
  if (state.screenCleanup) {
    state.screenCleanup();
    state.screenCleanup = null;
  }
}

function teardownSession() {
  clearOverlay();
  input.releaseLock();
  input.flush();
  if (state.hud) {
    state.hud.dispose();
    state.hud = null;
  }
  if (state.session) {
    state.session.dispose();
    state.session = null;
  }
  renderer.clear();
}

/* ------------------------------------------------------------------ */
/* screens                                                            */
/* ------------------------------------------------------------------ */
function showTitle() {
  teardownSession();
  runScreenCleanup();
  state.screen = 'title';
  renderTitle(ui, {
    save,
    onStart: () => {
      resumeAudio();
      sfx.select();
      showMapSelect();
    },
    onHelp: () => {
      const overlay = showHelp(ui, { onClose: () => { clearOverlay(); } });
      state.overlay = overlay;
    },
    onCredits: () => {
      const overlay = showCredits(ui, { onClose: () => { clearOverlay(); } });
      state.overlay = overlay;
    },
  });
}

function showMapSelect() {
  teardownSession();
  state.screen = 'mapSelect';
  runScreenCleanup();
  state.screenCleanup = renderMapSelect(ui, {
    selectedId: state.selectedMapId,
    onBack: showTitle,
    onNext: (mapId) => {
      state.selectedMapId = mapId;
      save.lastMapId = mapId;
      showDifficulty();
    },
  });
}

function showDifficulty() {
  teardownSession();
  state.screen = 'difficulty';
  runScreenCleanup();
  state.screenCleanup = renderDifficulty(ui, {
    mapId: state.selectedMapId,
    difficultyId: state.difficultyId,
    save,
    onBack: showMapSelect,
    onStart: (map, difficulty) => {
      state.selectedMapId = map.id;
      state.difficultyId = difficulty.id;
      save.lastMapId = map.id;
      save.lastDifficulty = difficulty.id;
      startGame(map, difficulty);
    },
  });
}

/* ------------------------------------------------------------------ */
/* game                                                               */
/* ------------------------------------------------------------------ */
async function startGame(map, difficulty) {
  if (state.starting) return;
  state.starting = true;
  teardownSession();
  runScreenCleanup();
  state.screen = 'game';

  const loading = showLoading(ui, { map });

  let session;
  try {
    session = new GameSession({
      renderer,
      canvas,
      map,
      difficulty,
      save,
      input,
      onHud: (s) => { if (state.hud) state.hud.update(s); },
      onEvent: (type, payload, kind) => {
        if (type === 'toast') toast(payload, kind);
        else if (type === 'damage') state.hud?.flashDamage();
      },
    });

    await session.load({
      onProgress: ({ loaded, total }) => loading.setProgress(loaded, total),
      onStage: (stage) => {
        if (stage === 'collision') loading.setIndeterminate('衝突判定 (BVH) を構築しています…');
        if (stage === 'nav') loading.setIndeterminate('ナビゲーションを準備しています…');
        if (stage === 'ready') loading.setIndeterminate('準備完了');
      },
    });
  } catch (error) {
    console.error(error);
    loading.fail(String(error?.message || error));
    state.starting = false;
    setOverlay(
      panelOverlay([
        el('h2', { text: 'マップを読み込めませんでした' }),
        el('p', { class: 'lead', text: String(error?.message || error) }),
        el('div', { class: 'actions' }, button('マップ選択へ戻る', { className: 'btn primary', onClick: showMapSelect })),
      ]),
    );
    return;
  }

  resize();
  state.session = session;
  state.hud = createHud(ui, {
    map,
    difficulty,
    onPause: () => pauseGame(),
  });

  session.setPaused(true);
  session.startLoop();
  state.hud.update(session.hudState());
  state.hud.setLocked(false);
  state.hud.showHint('WASD で移動 / マウスで視点 / Shift でダッシュ / F でライト', 6200);
  state.starting = false;

  // click anywhere on the lock overlay to grab the pointer
  const lockOverlay = state.hud.root.querySelector('.lockmsg');
  lockOverlay.addEventListener('click', () => {
    resumeAudio();
    // the overlay is hidden by the pointerlockchange handler once the lock is real
    session.setPaused(false);
    input.requestLock();
  });

}

function pauseGame() {
  const session = state.session;
  if (!session || session.finished || session.paused) return;
  session.setPaused(true);
  state.hud?.setLocked(false);
  state.suppressLockPause = true;
  input.releaseLock();
  setTimeout(() => { state.suppressLockPause = false; }, 60);
  clearOverlay();
  setOverlay(showPause(ui, {
    map: session.map,
    difficulty: session.difficulty,
    onResume: () => {
      clearOverlay();
      session.setPaused(false);
      input.requestLock();
    },
    onRetry: () => startGame(session.map, session.difficulty),
    onMapSelect: showMapSelect,
    onTitle: showTitle,
  }));
}

input.onLockChange = (locked) => {
  if (locked) {
    state.hud?.setLocked(true);
    return;
  }
  // pointer lock lost (Esc) -> pause, unless we did it ourselves
  if (state.suppressLockPause) return;
  if (state.screen === 'game' && state.session && !state.session.finished) {
    if (!state.session.paused) pauseGame();
    state.hud?.setLocked(false);
  }
};

window.addEventListener('keydown', (e) => {
  if (state.screen !== 'game' || !state.session) return;
  if (e.code === 'Escape' && !state.session.paused && !state.session.finished) {
    pauseGame();
  }
  if (!state.session.paused && !state.session.finished) state.session.handleKeyDown(e.code);
});

// pause the simulation when the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.session && !state.session.finished) pauseGame();
});

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */
resize();
showTitle();

// expose a small debug handle (useful for the acceptance checks)
window.__IIYAMA__ = { MAPS, DIFFICULTIES, save, state, renderer };
