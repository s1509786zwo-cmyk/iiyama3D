import { el, mount } from './dom.js';
import { formatTime } from '../core/save.js';
import { EYE_HEIGHT } from '../game/view.js';

export function createHud(root, { map, difficulty, onPause }) {
  const mapName = el('div', { class: 'mapname', text: map.name });
  const objLine = el('div', { class: 'obj', text: '' });
  const timer = el('div', { class: 'timer', text: '00:00' });
  const diffLine = el('div', { text: `難易度 ${difficulty.name} ／ 視点 ${EYE_HEIGHT.toFixed(2)} m` });
  const hpFill = el('div', { class: 'fill', style: { width: '100%' } });
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
    el('div', { class: 'top-left' }, mapName, objLine),
    el('div', { class: 'top-right' }, timer, diffLine),
    el(
      'div',
      { class: 'bottom-left' },
      el(
        'div',
        { class: 'meter hp' },
        el('div', { class: 'lbl', text: 'HEALTH' }),
        el('div', { class: 'shell' }, hpFill),
      ),
      el(
        'div',
        { class: 'meter st' },
        el('div', { class: 'lbl', text: 'STAMINA' }),
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
    const obj = state.exitActive
      ? '▶ 脱出地点へ戻れ'
      : `記録 ${state.collected} / ${state.total}`;
    if (obj !== last.obj) {
      objLine.textContent = obj;
      objLine.classList.toggle('done', state.exitActive);
      last.obj = obj;
    }
    const hp = Math.max(0, Math.round((state.health / state.maxHealth) * 100));
    if (hp !== last.hp) {
      hpFill.style.width = `${hp}%`;
      last.hp = hp;
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
