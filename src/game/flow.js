// UI flow / state machine: title -> map select -> difficulty -> game -> pause -> result.
//
// Everything DOM- and world-related is injected, so this module can be driven in Node
// (see tools/test_flow.mjs) exactly as the browser drives it.
import { STATUS } from './mapLibrary.js';
import { DIFFICULTIES } from './enemy.js';

export const SURVIVE_TARGET = 90; // seconds

export function createFlow({ registry, library, screens, world, input, save }) {
  const state = {
    selectedMapId: null,
    difficulty: null,
    running: false,
    paused: false,
    hp: 100,
    maxHp: 100,
    elapsed: 0,
    surviveTarget: SURVIVE_TARGET,
    startedAt: null,
    finished: false,
    lastSpawnedEnemies: 0,
    lastError: null,
  };

  const mapList = () => registry.maps.filter((m) => m.enabled !== false);
  const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

  // ---------------------------------------------------------------- boot
  async function boot() {
    screens.show('boot');
    screens.setBoot('マップ定義を読み込み中…', 0.05);
    await registry.load();
    const maps = mapList();
    if (!maps.length) throw new Error('有効なマップが 1 つも定義されていません');

    let done = 0;
    await Promise.all(
      maps.map((def) =>
        library
          .loadMap(def)
          .catch((err) => {
            state.lastError = err?.message || String(err);
            console.error(`[map:${def.id}]`, err);
          })
          .finally(() => {
            done++;
            screens.setBoot(`マップを読み込み中… (${done}/${maps.length})`, 0.15 + 0.8 * (done / maps.length));
          }),
      ),
    );
    const ready = maps.filter((m) => library.state.get(m.id)?.status === STATUS.READY).length;
    screens.setBoot(`${ready}/${maps.length} マップ読み込み完了`, 1);
    refreshTitle();
    return { ready, total: maps.length };
  }

  // ---------------------------------------------------------------- map select
  function openMapSelect() {
    const maps = mapList();
    const cur = state.selectedMapId || save.load().lastMapId;
    state.selectedMapId = cur && registry.get(cur) && library.state.get(cur)?.status === STATUS.READY ? cur : null;
    screens.renderMaps(maps, (id) => library.state.get(id) || { status: STATUS.IDLE, progress: 0 }, state.selectedMapId, selectMap);
    screens.setMapNextEnabled(!!state.selectedMapId && library.state.get(state.selectedMapId)?.status === STATUS.READY);
    const failed = maps.filter((m) => library.state.get(m.id)?.status === STATUS.ERROR);
    if (failed.length) {
      screens.setMapHint(
        `読み込めなかったマップ: ${failed.map((m) => m.sourceFile).join(', ')} — 該当マップは選択できません`,
      );
    } else if (state.selectedMapId) {
      const def = registry.get(state.selectedMapId);
      screens.setMapHint(`${def.label} を選択中 — 「次へ」で難易度選択へ`);
    } else {
      screens.setMapHint('マップを選択してください');
    }
    screens.show('maps');
  }

  function selectMap(def) {
    const st = library.state.get(def.id);
    if (st?.status === STATUS.ERROR) {
      screens.setMapHint(`${def.label}: 読み込みに失敗したため選択できません`);
      return false;
    }
    state.selectedMapId = def.id;
    screens.renderMaps(mapList(), (id) => library.state.get(id) || { status: STATUS.IDLE, progress: 0 }, state.selectedMapId, selectMap);
    screens.setMapNextEnabled(st?.status === STATUS.READY);
    screens.setMapHint(
      st?.status === STATUS.READY
        ? `${def.label} を選択中 — 「次へ」で難易度選択へ`
        : `${def.label}: 読み込みが完了していません`,
    );
    return true;
  }

  function openDifficulty() {
    const def = registry.get(state.selectedMapId);
    if (!def) return false;
    if (library.state.get(def.id)?.status !== STATUS.READY) {
      screens.setMapHint('このマップはまだ読み込めていません');
      return false;
    }
    const sel = state.difficulty || save.load().lastDifficulty || 'normal';
    state.difficulty = sel;
    screens.renderDifficulties(DIFFICULTIES, sel, (d) => {
      state.difficulty = d.id;
      screens.setDifficultySelection(d.id);
      screens.setDifficultyButtonState(true);
    });
    screens.setDifficultySelection(sel);
    screens.setDifficultyButtonState(true);
    if ($('difficulty-mapname')) $('difficulty-mapname').textContent = `${def.label} / ${def.sourceFile}`;
    screens.show('difficulty');
    return true;
  }

  // ---------------------------------------------------------------- game
  async function startGame(mapId = state.selectedMapId, difficultyId = state.difficulty) {
    const def = registry.get(mapId);
    if (!def) {
      state.lastError = 'マップが選択されていません';
      screens.showFatal('マップが選択されていません');
      return false;
    }
    const st = library.state.get(def.id);
    if (!st || st.status !== STATUS.READY) {
      // No substitution with another map: report and bounce back to the select screen.
      state.running = false;
      state.paused = false;
      state.lastError = `${def.sourceFile} を読み込めなかったため開始できません`;
      openMapSelect();
      screens.setMapHint(state.lastError);
      return false;
    }
    const diff = DIFFICULTIES.find((d) => d.id === difficultyId) || DIFFICULTIES[1];
    state.selectedMapId = def.id;
    state.difficulty = diff.id;
    state.maxHp = diff.hp;
    state.hp = diff.hp;
    state.elapsed = 0;
    state.paused = false;
    state.finished = false;

    world.clearMap();
    await world.setMap(st.data);
    const spawn = st.data.spawn;
    input.setYaw((spawn.yawDeg * Math.PI) / 180);
    state.lastSpawnedEnemies = world.startEnemies(diff);
    state.running = true;
    state.startedAt = Date.now();

    screens.setGameHud({ mapLabel: def.label, difficultyLabel: diff.label, fileName: def.sourceFile });
    screens.setMapNextEnabled(false);
    screens.setHp(state.hp, state.maxHp);
    screens.setObjective(`生き延びろ  0:00 / ${fmt(SURVIVE_TARGET)}`);
    screens.show('game');
    screens.toast(state.lastSpawnedEnemies ? `敵 ${state.lastSpawnedEnemies} 体 — 生き延びろ` : '敵はいない — 探索せよ');
    input.requestLock?.();
    return true;
  }

  function step(dt) {
    if (!state.running || state.paused) return;
    state.elapsed += dt;
    const wish = input.wishDir();
    world.controller.update(dt, wish, input.running(), input.consumeJump());
    const target = world.controller.position.clone();
    target.y += 0.9;
    for (const enemy of world.enemies) {
      enemy.update(dt, target, currentDifficulty(), (dmg) => hurt(dmg));
      if (!state.running) break;
    }
    screens.setObjective(`生き延びろ  ${fmt(state.elapsed)} / ${fmt(state.surviveTarget)}`);
    if (state.elapsed >= state.surviveTarget) finish(true);
  }

  function currentDifficulty() {
    return DIFFICULTIES.find((d) => d.id === state.difficulty) || DIFFICULTIES[1];
  }

  function hurt(dmg) {
    if (!state.running) return;
    state.hp = Math.max(0, state.hp - dmg);
    screens.setHp(state.hp, state.maxHp);
    if (state.hp <= 0) finish(false);
  }

  function finish(cleared) {
    if (state.finished) return;
    state.finished = true;
    state.running = false;
    input.releaseLock?.();
    const def = registry.get(state.selectedMapId);
    save.record({
      mapId: def?.id,
      difficulty: state.difficulty,
      survivedSeconds: Math.round(state.elapsed),
      cleared,
    });
    screens.showResult({ cleared, label: def?.label || '', elapsed: state.elapsed });
    refreshTitle();
  }

  function pause() {
    if (!state.running || state.paused) return;
    state.paused = true;
    input.releaseLock?.();
    screens.show('pause');
  }

  function resume() {
    if (!state.running) return;
    state.paused = false;
    screens.show('game');
    input.requestLock?.();
  }

  function retry() {
    if (!state.selectedMapId) return exitToMapSelect();
    state.paused = false;
    return startGame(state.selectedMapId, state.difficulty || 'normal');
  }

  function exitToMapSelect() {
    state.running = false;
    state.paused = false;
    state.finished = false;
    input.releaseLock?.();
    world.clearMap();
    openMapSelect();
  }

  function exitToTitle() {
    state.running = false;
    state.paused = false;
    input.releaseLock?.();
    world.clearMap();
    refreshTitle();
    screens.show('title');
  }

  function refreshTitle() {
    const data = save.load();
    if (!data.lastMapId) {
      screens.setTitleSaveInfo('セーブデータなし');
      screens.setContinueEnabled?.(false);
      return;
    }
    const def = registry.get(data.lastMapId);
    screens.setTitleSaveInfo(
      `前回: ${def?.label || data.lastMapId} / ${data.lastDifficulty} — 累計 ${data.totalRuns} 回`,
    );
    screens.setContinueEnabled?.(true);
  }

  return {
    state,
    boot,
    openMapSelect,
    openDifficulty,
    selectMap,
    startGame,
    step,
    pause,
    resume,
    retry,
    finish,
    hurt,
    exitToMapSelect,
    exitToTitle,
    refreshTitle,
  };
}

export function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
