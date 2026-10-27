/** Keyboard + mouse + pointer-lock input. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.enabled = true;
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    this._onBlur = () => this.keys.clear();
    this._onMouseDown = (e) => {
      if (this.onMouseDown) this.onMouseDown(e);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
  }

  requestLock() {
    if (!this.canvas.requestPointerLock) return;
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  consumeMouse() {
    const out = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  isDown(code) {
    return this.keys.has(code);
  }

  /** normalised WASD vector in camera space: x = strafe, z = forward */
  moveVector() {
    let x = 0;
    let z = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) z += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) z -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  }

  flush() {
    this.dx = 0;
    this.dy = 0;
    this.keys.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.releaseLock();
  }
}
