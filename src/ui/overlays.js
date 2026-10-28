import { el, mount, button, clear } from './dom.js';
import { MAPS } from '../maps/mapData.js';

export function panelOverlay(content, { onBackdrop } = {}) {
  const overlay = el('div', { class: 'overlay' }, el('div', { class: 'panel' }, content));
  if (onBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) onBackdrop();
    });
  }
  return overlay;
}

export function showHelp(root, { onClose }) {
  const overlay = panelOverlay(
    [
      el('h2', { text: '操作方法' }),
      el('p', { class: 'lead', text: '一人称視点の探索モードです。マップ内を自由に歩き、構造やスケールを確かめられます。' }),
      el(
        'div',
        { class: 'keys' },
        el('kbd', { text: 'W A S D' }), el('span', { text: '移動（矢印キーでも可）' }),
        el('kbd', { text: 'マウス' }), el('span', { text: '視点操作（クリックでマウスを固定）' }),
        el('kbd', { text: 'Shift' }), el('span', { text: 'ダッシュ（スタミナを消費）' }),
        el('kbd', { text: 'Space' }), el('span', { text: 'ジャンプ（段差や瓦礫の乗り越え）' }),
        el('kbd', { text: 'F' }), el('span', { text: 'フラッシュライトの ON / OFF' }),
        el('kbd', { text: 'Esc' }), el('span', { text: 'ポーズメニュー' }),
      ),
      el('p', { class: 'lead', style: { marginTop: '18px' }, text: '現在このバージョンでは敵は出現せず、記録回収や脱出の目標もありません（実装は残してあるので後から有効化できます）。' }),
      el('div', { class: 'actions' }, button('閉じる', { className: 'btn primary', onClick: onClose })),
    ],
    { onBackdrop: onClose },
  );
  mount(root, overlay);
  return overlay;
}

export function showCredits(root, { onClose }) {
  const overlay = panelOverlay(
    [
      el('h2', { text: 'クレジット / 素材' }),
      el('p', {
        class: 'lead',
        text: 'マップは Google Drive に保存されていた以下の GLB ファイルを、プロジェクト内に取り込んで使用しています。元の形状・テクスチャ・マテリアルは保持されています。',
      }),
      el(
        'div',
        { class: 'keys', style: { gridTemplateColumns: '1fr' } },
        ...MAPS.flatMap((map) => [
          el('div', {
            style: { fontSize: '12.5px', lineHeight: '1.8' },
            html: `<b>${map.name}</b><br><span style="font-family:var(--mono);font-size:10.5px;color:#7d9096">${map.sourceFile}</span>`,
          }),
        ]),
      ),
      el('p', {
        class: 'lead',
        style: { marginTop: '16px', fontSize: '12px' },
        text: 'モデル作者: abandoned city street for games / dasy444、Abandoned Warehouse - Interior Scene / Aurélien Martel、Subway train interior / Lukas Hahn 3D、Abandoned classroom / Pasha（Sketchfab）。ライセンスは各モデルの表記に従います。',
      }),
      el('div', { class: 'actions' }, button('閉じる', { className: 'btn primary', onClick: onClose })),
    ],
    { onBackdrop: onClose },
  );
  mount(root, overlay);
  return overlay;
}

export function showPause(root, { onResume, onRetry, onMapSelect, onTitle, map, difficulty }) {
  const overlay = panelOverlay([
    el('div', { class: 'result-badge', text: 'PAUSED' }),
    el('h2', { text: 'ポーズ' }),
    el('p', { class: 'lead', text: `${map.name} ─ 難易度 ${difficulty.name}` }),
    el(
      'div',
      { class: 'actions' },
      button('再開する', { className: 'btn primary', key: 'Esc', onClick: onResume }),
      button('このマップをやり直す', { className: 'btn', onClick: onRetry }),
      button('マップ選択へ戻る', { className: 'btn ghost', onClick: onMapSelect }),
      button('タイトルへ戻る', { className: 'btn ghost', onClick: onTitle }),
    ),
  ]);
  mount(root, overlay);
  return overlay;
}

export function showLoading(root, { map }) {
  const fill = el('div', { class: 'bar-fill' });
  const status = el('div', { class: 'stat', text: 'モデルを読み込んでいます…' });
  const screen = el(
    'div',
    { class: 'screen loading-screen' },
    el('div', { class: 'ring' }),
    el('h2', { text: map.name }),
    el('div', { class: 'file', text: map.sourceFile }),
    el('div', { class: 'bar-shell' }, fill),
    status,
  );
  mount(root, screen);
  return {
    setProgress(loaded, total) {
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      status.textContent = `読み込み中 ${pct}%  (${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`;
    },
    setStatus(text) {
      status.textContent = text;
    },
    setIndeterminate(text) {
      fill.style.width = '100%';
      status.textContent = text;
    },
    fail(message) {
      clear(screen);
      screen.append(
        el('h2', { text: '読み込みに失敗しました' }),
        el('div', { class: 'file', text: map.sourceFile }),
        el('p', { class: 'lead', text: message }),
      );
    },
  };
}
