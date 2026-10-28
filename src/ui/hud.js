import { el, mount } from './dom.js';
import { formatTime } from '../core/save.js';
import { EYE_HEIGHT } from '../game/view.js';

/**
 * Exploration HUD: map name, elapsed time, sprint stamina and the eye height
 * (so the player can see the viewpoint is identical on every map).
 * No objective counters — the game is free exploration now.
 */
export function createHud(root, { map, difficulty, onPause }) {
  const mapName = el('div', { class: 'mapname', text: map.name });
  const mapLine = el('div', { text: `広さ ${map.sizeLabel}` });
  const timer = el('div', { class: 'timer', text: '00:00' });
  const eyeLine = el('div', { text: `視点 ${EYE_HEIGHT.toFixed(2)} m` });
  const stFill = el('div', { class: 'fill', style: { width: '100%' } });
  const hint = el('div', { class: 'hint' });
  const damage = el('div', { class: 'damage' });
  const lockMsg = el(
    'div',
    { class: 'lockmsg', style: { display: 'none' } },
    el('div', { text: 'クリックして操作を再開' }),
    el('small', { text: 'マウスで視点 / WASD で移動 / Esc でポーズ' }),
  );

  const hud = el(
    'div',
    { class: 'hud' },
    el('div', { class: 'top-left' }, mapName, mapLine),
    el('div', { class: 'top-right' }, timer, eyeLine),
    el(
      'div',
      { class: 'bottom-left' },
      el(
        'div',
        { class: 'meter st' },
        el('div', { class: 'lbl', text: 'SPRINT' }),
        el('div', { class: 'shell' }, stFill),
      ),
    ),
    el('div', { class: 'crosshair' }),
    hint,
    el('button', { class: 'pausebtn', text: 'ポーズ (Esc)', onClick: onPause }),
    lockMsg,
    damage,
  );

  mount(root, hud);

  let damageTimer = null;
  let hintTimer = null;
  let last = {};

  const update = (state) => {
    const time = formatTime(state.time);
    if (time !== last.time) {
      timer.textContent = time;
      last.time = time;
    }
    const st = Math.max(0, Math.round(state.stamina * 100));
    if (st !== last.st) {
      stFill.style.width = `${st}%`;
      last.st = st;
    }
  };

  return {
    root: hud,
    update,
    showHint(text, duration = 4200) {
      hint.textContent = text;
      hint.classList.add('show');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.remove('show'), duration);
    },
    flashDamage() {
      damage.style.opacity = '1';
      clearTimeout(damageTimer);
      damageTimer = setTimeout(() => { damage.style.opacity = '0'; }, 90);
    },
    setLocked(locked) {
      lockMsg.style.display = locked ? 'none' : 'flex';
    },
    setVisible(visible) {
      hud.style.display = visible ? '' : 'none';
    },
    dispose() {
      clearTimeout(damageTimer);
      clearTimeout(hintTimer);
      hud.remove();
    },
  };
}
