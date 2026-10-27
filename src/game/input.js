// Keyboard + pointer-lock mouse input.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.locked = false;
    this._jumpQueued = false;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
      if (e.code === 'Space') this._jumpQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.06;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
  }

  requestLock() {
    if (this.locked) return;
    try {
      // may reject when the call is not driven by a user gesture (e.g. after an await);
      // the canvas click handler locks again on the first click, so failures are harmless.
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setYaw(yawRad) {
    this.yaw = yawRad;
    this.pitch = 0;
  }

  /** world-space wish direction from WASD relative to the camera yaw */
  wishDir() {
    let f = 0;
    let s = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s -= 1;
    if (!f && !s) return { x: 0, z: 0 };
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = (-sin, -cos) in world space for three.js yaw
    let x = -sin * f + cos * s;
    let z = -cos * f - sin * s;
    const len = Math.hypot(x, z);
    return { x: x / len, z: z / len };
  }

  running() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consumeJump() {
    const j = this._jumpQueued;
    this._jumpQueued = false;
    return j;
  }
}
