import * as THREE from 'three';

/**
 * First-person player. Human scale is normalised to a real body size for every
 * map (height 1.8 m, eye 1.68 m) and each map is uniformly scaled so its doors,
 * desks and ceilings match that scale.
 */
export const PLAYER = {
  height: 1.8,
  eyeHeight: 1.68,
  crouchHeight: 1.22,
  crouchEye: 1.02,
  radius: 0.3,
  walkSpeed: 3.3,
  sprintSpeed: 5.5,
  crouchSpeed: 1.7,
  accel: 26,
  jumpSpeed: 4.4,
  gravity: 19,
  stepHeight: 0.38,
  maxStamina: 100,
  staminaDrain: 21,
  staminaRegen: 13,
};

export class Player {
  constructor(camera, collision) {
    this.camera = camera;
    this.collision = collision;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = PLAYER.height;
    this.eye = PLAYER.eyeHeight;
    this.grounded = false;
    this.crouching = false;
    this.stamina = PLAYER.maxStamina;
    this.sprinting = false;
    this.bob = 0;
    this.health = 100;
    this.walked = 0;
    this._tmpDir = new THREE.Vector3();
    this.enabled = false;
  }

  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = 100;
    this.stamina = PLAYER.maxStamina;
    this.grounded = false;
    this.crouching = false;
    this.syncCamera(0);
  }

  look(dx, dy, sensitivity = 1) {
    const s = 0.0022 * sensitivity;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  update(dt, input) {
    if (!this.enabled) return;
    const wish = this._tmpDir.set(0, 0, 0);
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) wish.z -= 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) wish.z += 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) wish.x -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) wish.x += 1;

    const wantsCrouch = input.isDown('ControlLeft') || input.isDown('ControlRight') || input.isDown('KeyC');
    if (wantsCrouch !== this.crouching) {
      const targetHeight = wantsCrouch ? PLAYER.crouchHeight : PLAYER.height;
      const targetEye = wantsCrouch ? PLAYER.crouchEye : PLAYER.eyeHeight;
      if (!wantsCrouch) {
        // Only stand up when there is room above.
        const probe = this.collision.ceilingInfo(this.position.x, this.position.z, this.position.y + 0.1, PLAYER.height + 0.15);
        if (probe && probe.clearance < PLAYER.height + 0.05) {
          // stay crouched
        } else {
          this.crouching = false;
          this.height = targetHeight;
          this.eye = targetEye;
        }
      } else {
        this.crouching = true;
        this.height = targetHeight;
        this.eye = targetEye;
      }
    }

    const moving = wish.lengthSq() > 0;
    if (moving) wish.normalize();
    const wantSprint = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && moving && !this.crouching && this.stamina > 1;
    this.sprinting = wantSprint;

    let speed = this.crouching ? PLAYER.crouchSpeed : wantSprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    if (wantSprint) {
      this.stamina = Math.max(0, this.stamina - PLAYER.staminaDrain * dt);
    } else {
      this.stamina = Math.min(PLAYER.maxStamina, this.stamina + PLAYER.staminaRegen * dt);
    }
    if (!wantSprint) speed = this.crouching ? PLAYER.crouchSpeed : PLAYER.walkSpeed;

    // Camera-relative movement.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dirX = wish.x * cos - wish.z * sin;
    const dirZ = wish.x * sin + wish.z * cos;

    const targetVX = dirX * speed;
    const targetVZ = dirZ * speed;
    const a = Math.min(1, PLAYER.accel * dt);
    this.velocity.x += (targetVX - this.velocity.x) * a;
    this.velocity.z += (targetVZ - this.velocity.z) * a;
    if (!moving && this.grounded) {
      this.velocity.x *= Math.max(0, 1 - 12 * dt);
      this.velocity.z *= Math.max(0, 1 - 12 * dt);
    }

    // Gravity / jump.
    this.velocity.y -= PLAYER.gravity * dt;
    if (this.grounded && input.wasPressed('Space')) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.grounded = false;
    }

    // Horizontal move with wall sliding.
    const moved = this.collision.moveCapsule(
      this.position,
      { x: this.velocity.x * dt, z: this.velocity.z * dt },
      PLAYER.radius,
      this.height,
      PLAYER.stepHeight,
    );
    // Kill velocity along blocked axes so we do not build up speed into walls.
    if (Math.abs(moved.x - (this.position.x + this.velocity.x * dt)) > 1e-4) this.velocity.x = 0;
    if (Math.abs(moved.z - (this.position.z + this.velocity.z * dt)) > 1e-4) this.velocity.z = 0;
    this.walked += Math.hypot(moved.x - this.position.x, moved.z - this.position.z);
    this.position.x = moved.x;
    this.position.z = moved.z;

    // Vertical move.
    this.position.y += this.velocity.y * dt;

    // Ground resolution: snap to floors and allow step up/down.
    const fromY = this.position.y + PLAYER.stepHeight + 0.4;
    const ground = this.collision.groundInfo(this.position.x, this.position.z, fromY, PLAYER.stepHeight + 1.4);
    if (ground) {
      if (this.position.y <= ground.y + 0.06) {
        this.position.y = ground.y;
        this.velocity.y = 0;
        this.grounded = true;
      } else if (ground.y <= this.position.y + PLAYER.stepHeight && this.velocity.y <= 0 && this.position.y - ground.y < 0.42) {
        this.position.y = ground.y;
        this.velocity.y = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    } else {
      this.grounded = false;
    }

    // Head bob while walking on the ground.
    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && planarSpeed > 0.6) {
      this.bob += dt * (this.sprinting ? 12 : 8.5);
    } else {
      this.bob += dt * 1.6;
    }

    this.syncCamera(dt);
  }

  syncCamera() {
    const bobAmount = this.grounded ? Math.sin(this.bob) * (this.sprinting ? 0.035 : 0.018) : 0;
    const bobRoll = this.grounded ? Math.sin(this.bob * 0.5) * 0.004 : 0;
    this.camera.position.set(this.position.x, this.position.y + this.eye + bobAmount, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = bobRoll;
  }

  /** Direction the camera is facing. */
  getForward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
  }
}
