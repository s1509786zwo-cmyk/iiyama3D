import { el, mount, button } from './dom.js';
import { MAPS } from '../maps/mapData.js';
import { probeMap, clearPreviewCache } from '../core/assets.js';
import { sfx } from '../core/audio.js';

/**
 * Map selection screen.
 *
 * Each card is an independent map entry: it shows the preview rendered from the
 * real 3D model, the original Google Drive file name, its load state and a
 * select button. A map that fails to load shows an error and can never be
 * replaced by another map.
 */

/** module-level so progress survives going back and forth between screens */
const probeState = new Map();
const listeners = new Set();
let probing = false;

const stateOf = (id) => probeState.get(id) || { state: 'pending' };
const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* detached screen */ } } };

async function runProbes(maps) {
  if (probing) return;
  probing = true;
  for (const map of maps) {
    const current = stateOf(map.id);
    if (current.state === 'ready' || current.state === 'failed' || current.state === 'loading') continue;
    probeState.set(map.id, { state: 'loading', progress: 0 });
    notify();
    let result;
    try {
      result = await probeMap(map, {
        onProgress: ({ loaded, total }) => {
          const prev = stateOf(map.id);
          if (prev.state !== 'loading') return;
          probeState.set(map.id, { state: 'loading', progress: total ? loaded / total : 0 });
          notify();
        },
      });
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    probeState.set(map.id, result.ok
      ? { state: 'ready', thumb: result.thumb, info: result }
      : { state: 'failed', error: result.error || 'unknown error' });
    notify();
  }
  probing = false;
}

export function renderMapSelect(root, { selectedId, onBack, onNext }) {
  let selected = selectedId || null;

  const cards = new Map();
  const footInfo = el('div', { class: 'info' });
  const nextBtn = button('次へ', {
    className: 'btn primary',
    key: 'Enter',
    disabled: true,
    onClick: () => commit(),
  });

  const commit = () => {
    const chosen = selected && stateOf(selected).state === 'ready' ? selected : null;
    if (chosen) {
      sfx.select();
      onNext(chosen);
    }
  };

  const select = (id) => {
    if (stateOf(id).state !== 'ready') return;
    selected = id;
    sfx.ui();
    refresh();
  };

  const screen = el('div', { class: 'screen' });
  const scroll = el('div', { class: 'screen-scroll' });
  const grid = el('div', { class: 'cards' });

  scroll.append(
    el(
      'div',
      { class: 'screen-head' },
      el('div', {}, el('h1', { text: 'マップ選択' })),
      el('div', {
        class: 'sub',
        html: 'Google Drive から読み込んだ4つのマップ<br>プレビューは各モデルを実際に描画して生成しています',
      }),
    ),
    grid,
    el('div', {
      class: 'footnote',
      text: '※ 初回はモデルの取得・解析・プレビュー生成のため時間がかかります。2回目以降はキャッシュから即座に表示されます。／ 現在はマップ探索モードです（記録回収・脱出・敵はありません）。',
    }),
  );

  const foot = el(
    'div',
    { class: 'screen-foot' },
    footInfo,
    el(
      'div',
      { class: 'actions' },
      button('戻る', { className: 'btn ghost', key: 'Esc', onClick: () => { sfx.ui(); onBack(); } }),
      nextBtn,
    ),
  );

  screen.append(scroll, foot);
  mount(root, screen);

  // ---------------- card construction ----------------
  for (const map of MAPS) {
    const thumbBox = el('div', { class: 'thumb' });
    const badge = el('div', { class: 'state', text: '待機' });
    const bar = el('div', { class: 'bar', style: { width: '0%' } });
    const err = el('div', { class: 'err' });
    err.style.display = 'none';

    const card = el(
      'div',
      { class: 'card', dataset: { id: map.id } },
      el('div', { class: 'pick' }),
      thumbBox,
      el(
        'div',
        { class: 'body' },
        el(
          'div',
          { class: 'name' },
          el('span', { class: 'num', text: `0${map.index + 1}` }),
          el('span', { text: map.name }),
        ),
        el('div', { class: 'fname', text: map.sourceFile }),
        err,
        el(
          'div',
          { class: 'meta' },
          el('span', { text: map.sizeLabel }),
          el('span', { text: `縮尺 ×${map.scale}` }),
          el('span', { text: `広さ ${map.sizeLabel}` }),
        ),
      ),
      badge,
      bar,
    );

    card.addEventListener('click', () => select(map.id));
    cards.set(map.id, { card, thumbBox, badge, bar, err, map });
    grid.append(card);
  }

  function paintCard(id) {
    const entry = cards.get(id);
    if (!entry) return;
    const { card, thumbBox, badge, bar, err, map } = entry;
    const st = stateOf(id);
    card.classList.remove('disabled', 'selected');
    err.style.display = 'none';

    if (st.state === 'ready') {
      badge.className = 'state ready';
      badge.textContent = '読込完了';
      bar.style.width = '100%';
      if (thumbBox.dataset.painted !== '1') {
        thumbBox.replaceChildren(el('img', { src: st.thumb, alt: `${map.name} のプレビュー` }));
        thumbBox.dataset.painted = '1';
      }
      if (selected === id) card.classList.add('selected');
    } else if (st.state === 'failed') {
      badge.className = 'state failed';
      badge.textContent = '読込失敗';
      bar.style.width = '100%';
      bar.style.background = 'var(--danger)';
      card.classList.add('disabled');
      thumbBox.replaceChildren(
        el('div', { class: 'ph', text: 'モデルを読み込めませんでした' }),
      );
      err.style.display = '';
      err.textContent = `エラー: ${st.error}`;
      if (!err.dataset.retry) {
        err.dataset.retry = '1';
        const retry = button('再試行', {
          className: 'btn small ghost',
          onClick: async (e) => {
            e.stopPropagation();
            clearPreviewCache(map);
            probeState.delete(id);
            refresh();
            runProbes(MAPS);
          },
        });
        retry.style.marginTop = '6px';
        err.append(el('br'), retry);
      }
    } else if (st.state === 'loading') {
      badge.className = 'state loading';
      badge.textContent = '読込中…';
      bar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
      const existing = thumbBox.querySelector('.ph');
      const label = `3Dモデルを解析中<br>${Math.round((st.progress || 0) * 100)}%`;
      if (existing) existing.innerHTML = label;
      else thumbBox.replaceChildren(el('div', { class: 'ph', html: label }));
      card.classList.add('disabled');
    } else {
      badge.className = 'state';
      badge.textContent = '待機';
      bar.style.width = '0%';
      card.classList.add('disabled');
      thumbBox.replaceChildren(el('div', { class: 'ph', text: '待機中' }));
    }
  }

  function refresh() {
    for (const id of cards.keys()) paintCard(id);
    const states = [...cards.keys()].map((id) => stateOf(id).state);
    const ready = states.filter((s) => s === 'ready').length;
    const failed = states.filter((s) => s === 'failed').length;
    const loading = states.filter((s) => s === 'loading').length;
    const selectedMap = selected ? MAPS.find((m) => m.id === selected) : null;
    const selectedReady = selectedMap && stateOf(selected).state === 'ready';

    nextBtn.disabled = !selectedReady;
    if (selectedReady) {
      footInfo.innerHTML = `選択中: <b>${selectedMap.name}</b> ─ ${selectedMap.sourceFile}`;
    } else {
      footInfo.textContent = failed
        ? `読み込み完了 ${ready} / ${MAPS.length} ─ 失敗 ${failed} 件（該当マップは選択できません）`
        : loading
          ? `読み込み完了 ${ready} / ${MAPS.length} ─ モデルを解析しています…`
          : `読み込み完了 ${ready} / ${MAPS.length}`;
    }
  }

  listeners.add(refresh);
  refresh();
  runProbes(MAPS);

  const onKey = (e) => {
    if (e.code === 'Escape') {
      sfx.ui();
      onBack();
    } else if (e.code === 'Enter' && !nextBtn.disabled) {
      commit();
    }
  };
  window.addEventListener('keydown', onKey);

  return () => {
    window.removeEventListener('keydown', onKey);
    listeners.delete(refresh);
  };
}
