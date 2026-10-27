import { el, mount, button } from './dom.js';
import { DIFFICULTIES, MAPS } from '../maps/mapData.js';
import { getCachedPreview } from '../core/assets.js';
import { getRecord, formatTime } from '../core/save.js';
import { sfx } from '../core/audio.js';

export function renderDifficulty(root, { mapId, difficultyId, save, onBack, onStart }) {
  const map = MAPS.find((m) => m.id === mapId);
  let selected = difficultyId || save.lastDifficulty || 'normal';
  const cards = new Map();
  const startBtn = button('この条件で開始', { className: 'btn primary', key: 'Enter', onClick: () => start() });

  const start = () => {
    if (!map) return;
    sfx.select();
    onStart(map, DIFFICULTIES.find((d) => d.id === selected) || DIFFICULTIES[1]);
  };

  const thumb = el('div', {
    class: 'thumbph',
    style: { width: '104px', aspectRatio: '16/10', borderRadius: '2px', border: '1px solid var(--line-soft)', background: '#0a0f12' },
  });

  const summary = el(
    'div',
    { class: 'summary' },
    thumb,
    el(
      'div',
      {},
      el('div', { class: 't', text: map ? map.name : 'マップ未選択' }),
      el('div', { class: 'f', text: map ? map.sourceFile : '' }),
      el('div', {
        class: 'd',
        text: map
          ? `${map.sizeLabel} ／ 縮尺 ×${map.scale} ／ 記録 ${map.objectives.length} 個 ／ 開始地点 (${map.spawn.x}, ${map.spawn.y}, ${map.spawn.z})`
          : '',
      }),
    ),
  );

  if (map) {
    getCachedPreview(map).then((cached) => {
      if (cached?.thumb) thumb.replaceWith(el('img', { src: cached.thumb, alt: `${map.name} のプレビュー` }));
    });
  }

  const enemyNote = el('p', {
    class: 'lead',
    style: { margin: '0 0 16px', fontSize: '12px', color: 'var(--dim)' },
    text: '※ 現在のバージョンでは敵は出現しません。下記の敵に関する数値は、後から有効化したときの設定値です。',
  });
  const grid = el('div', { class: 'diff-grid' });

  for (const diff of DIFFICULTIES) {
    const record = map ? getRecord(save, map.id, diff.id) : null;
    const card = el(
      'div',
      { class: 'diff', dataset: { id: diff.id } },
      el('span', { class: 'tag', text: diff.tag }),
      el('h3', { text: diff.name }),
      el('p', { text: diff.description }),
      el(
        'ul',
        {},
        el('li', {}, '敵の数', el('b', { text: `${diff.enemyCount}` })),
        el('li', {}, '移動速度', el('b', { text: `${diff.enemySpeed.toFixed(2)} m/s` })),
        el('li', {}, '発見距離', el('b', { text: `${diff.detectRange} m` })),
        el('li', {}, '被ダメージ', el('b', { text: `${diff.damage}` })),
        el('li', {}, '初期体力', el('b', { text: `${diff.health}` })),
        el('li', {}, '自己ベスト', el('b', { text: formatTime(record?.bestTime) })),
      ),
    );
    card.addEventListener('click', () => {
      selected = diff.id;
      sfx.ui();
      paint();
    });
    cards.set(diff.id, card);
    grid.append(card);
  }

  function paint() {
    for (const [id, card] of cards) card.classList.toggle('selected', id === selected);
  }
  paint();

  const screen = el(
    'div',
    { class: 'screen' },
    el(
      'div',
      { class: 'screen-scroll' },
      el(
        'div',
        { class: 'screen-head' },
        el('div', {}, el('h1', { text: '難易度選択' })),
        el('div', { class: 'sub', html: '選択したマップと条件でゲームを開始します<br>設定は自動的に保存されます' }),
      ),
      summary,
      enemyNote,
      grid,
    ),
    el(
      'div',
      { class: 'screen-foot' },
      el('div', { class: 'info', text: 'マップID: ' + (map ? map.id : '—') }),
      el(
        'div',
        { class: 'actions' },
        button('戻る', { className: 'btn ghost', key: 'Esc', onClick: () => { sfx.ui(); onBack(); } }),
        startBtn,
      ),
    ),
  );

  mount(root, screen);

  const onKey = (e) => {
    if (e.code === 'Escape') {
      sfx.ui();
      onBack();
    } else if (e.code === 'Enter') start();
  };
  window.addEventListener('keydown', onKey);

  return () => window.removeEventListener('keydown', onKey);
}
