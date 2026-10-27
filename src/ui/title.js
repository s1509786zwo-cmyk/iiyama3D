import { el, mount, button } from './dom.js';
import { MAPS, DIFFICULTIES } from '../maps/mapData.js';
import { formatTime, getRecord } from '../core/save.js';

export function renderTitle(root, { save, onStart, onHelp, onCredits }) {
  const bestTimes = MAPS.map((map) => {
    const records = DIFFICULTIES.map((d) => getRecord(save, map.id, d.id)?.bestTime).filter((t) => t != null);
    return { map, best: records.length ? Math.min(...records) : null };
  });

  const screen = el(
    'div',
    { class: 'screen' },
    el(
      'div',
      { class: 'title-wrap' },
      el(
        'div',
        { class: 'brand' },
        el('div', { class: 'kicker', text: 'First-person survival / 4 maps' }),
        el('h1', { text: 'IIYAMA 3D' }),
        el('div', { class: 'subtitle', text: '廃墟探索 ─ 記録回収任務' }),
        el('div', { class: 'rule' }),
        el('p', {
          class: 'lede',
          text: 'Google Drive に保存された4つの3Dマップをそのまま読み込み、廃墟に置き去りにされた記録を回収して脱出する。足音を立てれば、何かが寄ってくる。',
        }),
        el(
          'div',
          { class: 'menu' },
          button('ゲーム開始', { className: 'btn primary', key: 'MAP SELECT', onClick: onStart }),
          button('操作方法', { className: 'btn ghost', key: 'HELP', onClick: onHelp }),
          button('クレジット / 素材', { className: 'btn ghost', key: 'CREDITS', onClick: onCredits }),
        ),
      ),
      el(
        'div',
        { class: 'title-side' },
        el('h3', { text: 'Maps from Google Drive' }),
        el(
          'div',
          { class: 'map-list' },
          ...MAPS.map((map, i) =>
            el(
              'div',
              { class: 'row' },
              el('span', { class: 'idx', text: `0${i + 1}` }),
              el('span', { text: map.name }),
              el('span', { class: 'fname', text: map.sourceFile }),
            ),
          ),
        ),
        el('h3', { text: 'Records' }),
        el(
          'div',
          { class: 'spec' },
          ...bestTimes.map(({ map, best }) =>
            el('div', {}, `${map.short}  `, el('b', { text: formatTime(best) })),
          ),
          el('div', { style: { marginTop: '10px' } }, '脱出 ', el('b', { text: `${save.stats.escapes}` }), ' / 挑戦 ', el('b', { text: `${save.stats.plays}` })),
        ),
      ),
    ),
  );

  mount(root, screen);
}
