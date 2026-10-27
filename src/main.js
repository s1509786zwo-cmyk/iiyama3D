// IIYAMA 3D — entry point. Wires the real browser implementations into the UI flow.
import { MapRegistry } from './game/maps.js';
import { MapLibrary } from './game/mapLibrary.js';
import { World } from './game/world.js';
import { Input } from './game/input.js';
import { Screens } from './ui/screens.js';
import { loadSave, recordRun, writeSave } from './game/save.js';
import { createFlow } from './game/flow.js';

const $ = (id) => document.getElementById(id);

const registry = new MapRegistry();
const library = new MapLibrary();
const screens = new Screens();
const world = new World($('scene'));
const input = new Input($('scene'));

const flow = createFlow({
  registry,
  library,
  screens,
  world,
  input,
  save: { load: loadSave, write: writeSave, record: recordRun },
});

// --------------------------------------------------------------------------- UI wiring
function wireUI() {
  const on = (id, fn) => $(id)?.addEventListener('click', fn);

  on('btn-start', () => flow.openMapSelect());
  on('btn-continue', () => {
    const save = loadSave();
    if (save.lastMapId && registry.get(save.lastMapId) && library.state.get(save.lastMapId)?.status === 'ready') {
      flow.state.selectedMapId = save.lastMapId;
      flow.state.difficulty = save.lastDifficulty || 'normal';
      flow.startGame(save.lastMapId, save.lastDifficulty || 'normal');
    } else {
      flow.openMapSelect();
    }
  });
  on('btn-howto', () => {
    $('howto-panel').hidden = false;
  });
  on('btn-howto-close', () => {
    $('howto-panel').hidden = true;
  });

  on('btn-map-back', () => screens.show('title'));
  on('btn-map-next', () => flow.openDifficulty());
  on('btn-diff-back', () => flow.openMapSelect());
  on('btn-diff-start', () => flow.startGame(flow.state.selectedMapId, flow.state.difficulty));

  on('btn-resume', () => flow.resume());
  on('btn-retry-pause', () => flow.retry());
  on('btn-tomaps-pause', () => flow.exitToMapSelect());
  on('btn-title-pause', () => flow.exitToTitle());

  on('btn-result-retry', () => flow.retry());
  on('btn-result-maps', () => flow.exitToMapSelect());
  on('btn-result-title', () => flow.exitToTitle());

  // map-card state updates while loading
  library.onChange((id, st) => {
    const def = registry.get(id);
    if (!def) return;
    screens.updateMapCard(def, st, flow.state.selectedMapId === id);
    if (flow.state.selectedMapId === id) {
      screens.setMapNextEnabled(st.status === 'ready');
    }
  });

  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && flow.state.running && !flow.state.paused) flow.pause();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (flow.state.running && !flow.state.paused) flow.pause();
    else if (flow.state.paused) flow.resume();
  });
  $('scene').addEventListener('click', () => {
    if (flow.state.running && !flow.state.paused) input.requestLock();
  });
}

// --------------------------------------------------------------------------- loop
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (flow.state.running && !flow.state.paused) {
    flow.step(dt);
    world.render(input.yaw, input.pitch, dt);
  } else if (world.current) {
    world.renderer.render(world.scene, world.camera);
  }
}

wireUI();
flow
  .boot()
  .then(() => {
    screens.show('title');
    requestAnimationFrame(loop);
  })
  .catch((err) => {
    console.error(err);
    screens.showFatal(`起動に失敗しました:\n${err?.message || err}`);
  });

// GPU / driver hiccups should not leave a black screen without explanation
$('scene').addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  screens.showFatal('WebGL コンテキストが失われました。ページを再読み込みしてください。');
});

// exposed for debugging / automated checks
window.__iiyama = { flow, registry, library, world, input, screens };
