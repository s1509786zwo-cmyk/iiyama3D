// Screen management for title -> map select -> difficulty -> game -> result.
import { STATUS } from '../game/mapLibrary.js';
import { fmt as fmtTime } from '../game/flow.js';

const $ = (id) => document.getElementById(id);

export class Screens {
  constructor() {
    this.current = 'boot';
    this.el = {
      boot: $('screen-boot'),
      title: $('screen-title'),
      maps: $('screen-maps'),
      difficulty: $('screen-difficulty'),
      pause: $('screen-pause'),
      result: $('screen-result'),
    };
    this.hud = $('hud');
    this.toastTimer = null;
  }

  show(name) {
    for (const [key, el] of Object.entries(this.el)) {
      if (!el) continue;
      el.classList.toggle('active', key === name);
    }
    this.current = name;
    const inGame = name === 'game';
    this.hud.hidden = !inGame;
  }

  showFatal(message) {
    const el = $('fatal');
    el.hidden = false;
    el.textContent = message;
  }

  setBoot(text, progress) {
    $('boot-status').textContent = text;
    if (typeof progress === 'number') $('boot-bar').style.width = `${Math.round(progress * 100)}%`;
  }

  toast(text, ms = 2200) {
    const el = $('hud-toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- map select
  renderMaps(maps, stateOf, selectedId, onSelect) {
    const grid = $('map-grid');
    grid.innerHTML = '';
    for (const def of maps) {
      const st = stateOf(def.id);
      const card = document.createElement('div');
      card.className = 'map-card';
      card.dataset.mapId = def.id;
      if (selectedId === def.id) card.classList.add('selected');
      if (st.status === STATUS.ERROR) card.classList.add('error');

      const thumb = document.createElement('div');
      thumb.className = 'map-thumb';
      if (def.preview) thumb.style.backgroundImage = `url("${encodeURI(def.preview)}")`;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.role = 'badge';
      thumb.appendChild(badge);
      const check = document.createElement('span');
      check.className = 'check';
      thumb.appendChild(check);

      const meta = document.createElement('div');
      meta.className = 'map-meta';
      const name = document.createElement('div');
      name.className = 'map-name';
      name.textContent = def.label;
      const file = document.createElement('div');
      file.className = 'map-file';
      file.textContent = def.sourceFile;
      const progress = document.createElement('div');
      progress.className = 'map-progress';
      const bar = document.createElement('i');
      progress.appendChild(bar);
      const note = document.createElement('div');
      note.className = 'map-note';
      meta.append(name, file, progress, note);

      card.append(thumb, meta);
      card.addEventListener('click', () => onSelect(def));
      grid.appendChild(card);
      this.updateMapCard(def, st, selectedId === def.id);
    }
  }

  updateMapCard(def, st, selected) {
    const card = document.querySelector(`.map-card[data-map-id="${def.id}"]`);
    if (!card) return;
    card.classList.toggle('selected', selected);
    card.classList.toggle('error', st.status === STATUS.ERROR);
    const badge = card.querySelector('.badge');
    const bar = card.querySelector('.map-progress > i');
    const note = card.querySelector('.map-note');
    const labels = {
      [STATUS.IDLE]: ['未読み込み', ''],
      [STATUS.LOADING]: ['読み込み中', 'loading'],
      [STATUS.READY]: ['読み込み済み', 'ready'],
      [STATUS.ERROR]: ['読み込み失敗', 'error'],
    };
    const [text, cls] = labels[st.status] || ['不明', ''];
    badge.textContent = text;
    badge.className = `badge ${cls}`;
    bar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
    note.textContent = st.status === STATUS.ERROR ? `エラー: ${st.error || '読み込みに失敗しました'}` : '';
  }

  setMapHint(text) {
    $('map-hint').textContent = text;
  }

  setMapNextEnabled(enabled) {
    $('btn-map-next').disabled = !enabled;
  }

  // --------------------------------------------------------------- difficulty
  renderDifficulties(list, selectedId, onSelect) {
    const grid = $('diff-grid');
    grid.innerHTML = '';
    for (const d of list) {
      const card = document.createElement('div');
      card.className = `diff-card${selectedId === d.id ? ' selected' : ''}`;
      card.dataset.diffId = d.id;
      card.innerHTML = `<h3>${d.label}</h3><p>${d.desc}</p>`;
      card.addEventListener('click', () => onSelect(d));
      grid.appendChild(card);
    }
  }

  setDifficultyButtonState(enabled) {
    const b = $('btn-diff-start');
    if (b) b.disabled = !enabled;
  }

  setDifficultySelection(id) {
    document.querySelectorAll('.diff-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.diffId === id);
    });
  }

  setGameHud({ mapLabel, difficultyLabel, fileName }) {
    $('hud-map').textContent = fileName ? `${mapLabel} — ${fileName}` : mapLabel;
    $('hud-diff').textContent = difficultyLabel;
  }

  setHp(hp, max) {
    const bar = $('hud-hp');
    bar.style.width = `${Math.max(0, (hp / max) * 100)}%`;
    bar.parentElement.classList.toggle('low', hp / max <= 0.3);
  }

  setObjective(text) {
    $('hud-objective').textContent = text;
  }

  setTitleSaveInfo(text) {
    $('save-info').textContent = text;
  }

  setContinueEnabled(enabled) {
    const b = $('btn-continue');
    if (b) b.disabled = !enabled;
  }

  showResult({ cleared, label, elapsed }) {
    $('result-title').textContent = cleared ? '生還' : 'ゲームオーバー';
    $('result-sub').textContent = cleared
      ? `${label} を ${fmtTime(elapsed)} 生き延びた`
      : `${label} で倒れた — 生存時間 ${fmtTime(elapsed)}`;
    this.show('result');
  }
}
