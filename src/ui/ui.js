import { DIFFICULTIES } from '../game/GameApp.js';

const $ = (sel, root = document) => root.querySelector(sel);

function fmtTime(sec) {
  const s = Math.floor(sec || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * DOM screens: title, difficulty, map select, loading, HUD, pause, results.
 */
export class UI {
  constructor({ save, audio }) {
    this.save = save;
    this.audio = audio;
    this.screens = {
      title: $('#screen-title'),
      help: $('#screen-help'),
      difficulty: $('#screen-difficulty'),
      mapselect: $('#screen-mapselect'),
      loading: $('#screen-loading'),
      error: $('#screen-error'),
      game: $('#screen-game'),
      pause: $('#screen-pause'),
      result: $('#screen-result'),
    };
    this.mapGrid = $('#map-grid');
    this.diffGrid = $('#difficulty-grid');
    this.current = 'title';
    this.cards = new Map();
    this.selectedMapId = null;
    this.callbacks = {};
    this._bindGlobalButtons();
  }

  _bindGlobalButtons() {
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      this.audio?.click();
      this.callbacks.onAction?.(action, btn);
    });
  }

  setDifficultyMapLabel(text) {
    const el = $('#difficulty-map');
    if (el) el.textContent = `選択中のマップ: ${text}`;
  }

  show(name) {
    for (const [key, el] of Object.entries(this.screens)) {
      if (!el) continue;
      el.classList.toggle('active', key === name);
    }
    this.current = name;
  }

  setContinueVisible(visible) {
    const btn = $('#btn-continue');
    if (btn) btn.hidden = !visible;
  }

  /* ---------------- difficulty ---------------- */
  renderDifficulty(selectedId) {
    const el = this.diffGrid;
    el.innerHTML = '';
    for (const diff of Object.values(DIFFICULTIES)) {
      const card = document.createElement('button');
      card.className = `diff-card${diff.id === selectedId ? ' selected' : ''}`;
      card.dataset.difficulty = diff.id;
      card.innerHTML = `
        <span class="diff-sub">${diff.label}</span>
        <h3>${diff.title}</h3>
        <p>${diff.desc}</p>
        <p class="best">敵 ${Math.max(0, diff.enemyBonus) >= 0 ? '標準+' + diff.enemyBonus : '標準' + diff.enemyBonus} · 速度 x${diff.speed} · 攻撃 ${diff.damage}</p>
      `;
      card.addEventListener('click', () => {
        this.audio?.click();
        this.callbacks.onDifficulty?.(diff.id);
      });
      el.appendChild(card);
    }
  }

  /* ---------------- map select ---------------- */
  renderMaps(maps, selectedId) {
    this.mapGrid.innerHTML = '';
    this.cards.clear();
    $('#map-count').textContent = String(maps.length);
    maps.forEach((map, i) => {
      const card = document.createElement('article');
      card.className = `map-card${map.id === selectedId ? ' selected' : ''}`;
      card.dataset.mapId = map.id;
      card.innerHTML = `
        <div class="map-thumb">
          <div class="thumb-state" data-role="state">プレビュー生成待ち</div>
          <span class="thumb-badge" data-role="badge">#${i + 1}</span>
        </div>
        <div class="map-body">
          <span class="map-index">MAP ${String(i + 1).padStart(2, '0')}</span>
          <span class="map-title">${map.title}</span>
          <span class="map-file" title="${map.fileName}">${map.fileName}</span>
          <div class="map-meta"><span data-role="size">${fmtBytes(map.source?.bytes)}</span><span data-role="md5">${map.source?.md5 ? map.source.md5.slice(0, 8) : ''}</span></div>
          <span class="map-status loading" data-role="status">確認中…</span>
          <button class="btn pick" data-role="pick">このマップを選択</button>
        </div>
      `;
      card.querySelector('[data-role="pick"]').addEventListener('click', (e) => {
        e.stopPropagation();
        this.audio?.click();
        this.callbacks.onSelectMap?.(map.id);
      });
      this.mapGrid.appendChild(card);
      this.cards.set(map.id, card);
    });
  }

  updateMapCard(map) {
    const card = this.cards.get(map.id);
    if (!card) return;
    const statusEl = card.querySelector('[data-role="status"]');
    const stateEl = card.querySelector('[data-role="state"]');
    const thumb = card.querySelector('.map-thumb');

    if (map.status === 'ready') {
      statusEl.textContent = '読み込み可 · GLB 検証 OK';
      statusEl.className = 'map-status ok';
    } else if (map.status === 'error') {
      statusEl.textContent = `読込失敗: ${map.error || 'unknown'}`;
      statusEl.className = 'map-status bad';
      card.classList.add('failed');
    } else if (map.status === 'preview') {
      statusEl.textContent = 'プレビュー生成中…';
      statusEl.className = 'map-status loading';
    } else {
      statusEl.textContent = '確認中…';
      statusEl.className = 'map-status loading';
    }

    if (map.previewUrl) {
      let img = thumb.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = `${map.title} preview`;
        thumb.prepend(img);
      }
      img.src = map.previewUrl;
      stateEl.hidden = true;
    } else if (map.status === 'error') {
      stateEl.hidden = false;
      stateEl.textContent = 'プレビューなし';
    }
  }

  setSelectedMap(mapId, maps) {
    this.selectedMapId = mapId;
    for (const [id, card] of this.cards) {
      card.classList.toggle('selected', id === mapId);
      const btn = card.querySelector('[data-role="pick"]');
      if (btn) btn.textContent = id === mapId ? '選択中' : 'このマップを選択';
    }
    const map = maps.find((m) => m.id === mapId);
    const startBtn = $('#btn-start-run');
    startBtn.disabled = !map || map.status !== 'ready';
    startBtn.textContent = map && map.status === 'ready' ? '次へ' : '読み込み不可';
  }

  /* ---------------- loading ---------------- */
  showLoading(map) {
    $('#loading-title').textContent = `${map.title} を読み込み中`;
    $('#loading-file').textContent = map.fileName;
    $('#loading-bar').style.width = '0%';
    $('#loading-label').textContent = '0%';
    this.show('loading');
  }

  setLoadingProgress(ratio, note) {
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    $('#loading-bar').style.width = `${pct}%`;
    $('#loading-label').textContent = `${pct}%`;
    if (note) $('#loading-hint').textContent = note;
  }

  showError(detail) {
    $('#error-detail').textContent = detail;
    this.show('error');
  }

  /* ---------------- HUD ---------------- */
  updateHud(h) {
    if (!h) return;
    $('#hud-map-name').textContent = h.mapTitle;
    $('#hud-map-file').textContent = this.currentMapFile || '';
    $('#hud-objective').textContent = h.exitActive ? '脱出地点へ戻れ' : `記録 ${h.collected} / ${h.total}`;
    $('#hud-timer').textContent = fmtTime(h.elapsed);
    $('#hud-hp').style.width = `${Math.max(0, Math.min(100, h.health))}%`;
    $('#hud-stamina').style.width = `${Math.max(0, Math.min(100, h.stamina))}%`;
    $('#hud-fps').textContent = h.fps || '--';
    $('#hud-tris').textContent = h.triangles ? `${Math.round(h.triangles / 1000)}k tri` : '--';
  }

  setHudDifficulty(label) {
    $('#hud-difficulty').textContent = label;
  }

  showToast(text, ms = 1800) {
    const el = $('#hud-toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  flashDamage() {
    const v = $('#damage-vignette');
    v.style.opacity = '1';
    clearTimeout(this._dmgTimer);
    this._dmgTimer = setTimeout(() => (v.style.opacity = '0'), 140);
    const m = $('#hit-marker');
    m.style.opacity = '0.9';
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => (m.style.opacity = '0'), 120);
  }

  hideHudHint() {
    $('#hud-hint')?.classList.add('hidden');
  }

  setLockPrompt(visible) {
    const el = $('#pointer-lock-prompt');
    if (el) el.hidden = !visible;
  }

  /* ---------------- pause / result ---------------- */
  showPause(map, difficultyId) {
    $('#pause-sub').textContent = `${map?.title || ''} · ${DIFFICULTIES[difficultyId]?.label || ''}`;
    this.show('pause');
  }

  showResult({ escaped, elapsed, collected, total, map, difficulty, entry }) {
    $('#result-eyebrow').textContent = escaped ? 'escaped' : 'run failed';
    $('#result-title').textContent = escaped ? '脱出成功' : '回収不能';
    $('#result-title').style.color = escaped ? 'var(--accent)' : 'var(--danger)';
    const best = entry?.bestTime ? fmtTime(entry.bestTime) : '—';
    $('#result-stats').innerHTML = `
      <div><span>マップ</span><b>${map?.title || ''}</b></div>
      <div><span>難易度</span><b>${DIFFICULTIES[difficulty]?.label || difficulty}</b></div>
      <div><span>タイム</span><b>${fmtTime(elapsed)}</b></div>
      <div><span>回収</span><b>${collected} / ${total}</b></div>
      <div><span>ベスト</span><b>${best}</b></div>
      <div><span>クリア回数</span><b>${entry?.completions ?? 0}</b></div>
    `;
    this.show('result');
  }
}
