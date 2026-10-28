/**
 * A single playthrough on one map.
 * Owns the three.js scene, the player and the game loop (exploration mode).
 */
import {
  Scene, PerspectiveCamera, Color, Fog, HemisphereLight, DirectionalLight,
  AmbientLight, SpotLight, Object3D, Vector3, PointLight, PMREMGenerator,
  Group,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadMapModel, buildMapCollision, disposeModel } from '../core/assets.js';
import { CharacterBody, NavGrid } from '../core/collision.js';
import { Enemy } from './enemy.js';
import { EYE_HEIGHT, FOV, PLAYER_HEIGHT, PLAYER_RADIUS, WALK_SPEED, SPRINT_SPEED } from './view.js';
import { sfx } from '../core/audio.js';
import { formatTime } from '../core/save.js';

/** enemies are intentionally disabled for now (set true to bring them back) */
const ENEMIES_ENABLED = false;

const _v = new Vector3();
const _w = new Vector3();

export class GameSession {
  constructor({ renderer, canvas, map, difficulty, save, input, onHud, onEvent, onWin, onLose }) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.input = input || null;
    this.map = map;
    this.difficulty = difficulty;
    this.save = save;
    this.onHud = onHud || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onWin = onWin || (() => {});
    this.onLose = onLose || (() => {});

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(FOV, 1, 0.05, 500);
    this.camera.rotation.order = 'YXZ';
    this.clock = null;
    this.running = false;
    this.paused = false;
    this.finished = false;
    this.elapsed = 0;
    this.raf = null;
    this.model = null;
    this.collision = null;
    this.enemies = [];

    this.health = difficulty.health;
    this.maxHealth = difficulty.health;
    this.stamina = 1;
    this.exitPulse = 0;
    this.stepTimer = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = save?.settings?.sensitivity ?? 1;
    this.invertY = save?.settings?.invertY ?? false;
    this.timeScale = 1;
    this.floorY = 0;
    this.eyeAboveFloor = EYE_HEIGHT;
    this.lastRespawn = -99;
    this.safePosition = null;
    this.airborneFrames = 0;
  }

  /* ---------------------------------------------------------------- */
  /* setup                                                            */
  /* ---------------------------------------------------------------- */
  async load({ onProgress, onStage } = {}) {
    onStage?.('model');
    const { root, box, size } = await loadMapModel(this.map, { onProgress });
    this.model = root;
    this.bounds = box;
    this.size = size;
    this.scene.add(root);

    onStage?.('collision');
    this.collision = buildMapCollision(root);
    this.bvh = this.collision.bvh;

    onStage?.('nav');
    this.nav = new NavGrid(this.map.grid);

    this.setupWorld();
    this.setupPlayer();
    this.setupEnemies();
    this.onHud(this.hudState());
    onStage?.('ready');
  }

  setupWorld() {
    const map = this.map;
    this.scene.fog = new Fog(new Color(map.fogColor), map.fog[0], map.fog[1]);
    this.scene.background = new Color(map.fogColor);

    this.hemi = new HemisphereLight(0xaebfca, 0x141a1e, map.ambient ?? 0.5);
    this.scene.add(this.hemi);

    this.ambient = new AmbientLight(0x6f8492, 0.5);
    this.scene.add(this.ambient);

    this.sun = new DirectionalLight(new Color(map.sunColor || '#c8d4dc'), map.sunIntensity ?? 1.2);
    const center = this.bounds.getCenter(new Vector3());
    this.sun.position.copy(center).add(new Vector3(12, 26, 9));
    this.sun.target.position.copy(center);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // flashlight — the only reliable light source inside these buildings
    this.flashlight = new SpotLight(0xfff0d0, 42, 36, Math.PI / 6.5, 0.6, 1.35);
    this.flashlight.position.set(0.18, -0.12, 0.1);
    this.flashlightTarget = new Object3D();
    this.flashlightTarget.position.set(0, 0, -1);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;
    this.scene.add(this.camera);

    this.eyeLight = new PointLight(0x9fd0d8, 2.4, 7, 2);
    this.camera.add(this.eyeLight);

    try {
      const pmrem = new PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.22;
      pmrem.dispose();
    } catch {
      /* environment is optional */
    }
  }

  setupPlayer() {
    const spawn = this.map.spawn;
    this.body = new CharacterBody({ bvh: this.bvh, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
    this.body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
    this.body.resolve();
    // measure the real floor under the spawn so the eye line is exact
    const floor = this.body.groundY(0.6);
    if (floor !== null) {
      this.body.position.y = floor + 0.001;
      this.body.grounded = true;
    }
    this.floorY = floor ?? this.body.position.y;
    this.yaw = spawn.yaw ?? 0;
    this.pitch = 0;
    this.syncCamera();
  }

  setupEnemies() {
    if (!ENEMIES_ENABLED) return;
    const spawn = this.map.spawn;
    const patrols = [...this.map.patrols].sort((a, b) => {
      const da = Math.hypot(a.x - spawn.x, a.z - spawn.z);
      const db = Math.hypot(b.x - spawn.x, b.z - spawn.z);
      return db - da; // farthest first, keeps the player from being jumped at spawn
    });
    const count = Math.min(this.difficulty.enemyCount, Math.max(1, patrols.length));
    for (let i = 0; i < count; i++) {
      const spot = patrols[i % patrols.length] || spawn;
      const enemy = new Enemy({
        scene: this.scene,
        bvh: this.bvh,
        nav: this.nav,
        map: this.map,
        difficulty: this.difficulty,
        spawn: spot,
        index: i,
      });
      enemy.onSay = () => sfx.alert();
      this.enemies.push(enemy);
    }
  }

  /* ---------------------------------------------------------------- */
  /* camera / hud                                                     */
  /* ---------------------------------------------------------------- */
  syncCamera() {
    const p = this.body.position;
    // the feet position is kept on the floor by the controller, so this is the
    // same eye height (1.62 m) in every map, no matter the model's scale
    this.camera.position.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.eyeAboveFloor = p.y + EYE_HEIGHT - this.floorY;
  }

  hudState() {
    return {
      stamina: this.stamina,
      time: this.elapsed,
      yaw: this.yaw,
      eyeAboveFloor: this.eyeAboveFloor,
      fov: FOV,
    };
  }

  /* ---------------------------------------------------------------- */
  /* input                                                            */
  /* ---------------------------------------------------------------- */
  handleKeyDown(code) {
    if (this.finished) return;
    if (code === 'KeyF') {
      this.flashlight.visible = !this.flashlight.visible;
      this.onEvent('toast', this.flashlight.visible ? 'ライト ON' : 'ライト OFF');
    }
  }

  look(dx, dy) {
    const sens = 0.0023 * this.sensitivity;
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (this.invertY ? -1 : 1);
    const limit = Math.PI / 2 - 0.08;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  /* ---------------------------------------------------------------- */
  /* loop                                                             */
  /* ---------------------------------------------------------------- */
  loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0.0001, now - this.clock.last));
    this.clock.last = now;
    if (!this.paused && !this.finished) this.update(dt);
    this.render();
  };

  update(dt) {
    this.elapsed += dt;

    if (this.input && this.input.locked) {
      const mouse = this.input.consumeMouse();
      if (mouse.x || mouse.y) this.look(mouse.x, mouse.y);
    }

    // ---------------- movement ----------------
    const keys = this.input ? this.input.keys : new Set();
    const move = this.input ? this.input.moveVector() : { x: 0, z: 0 };
    const forward = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = _w.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new Vector3()
      .addScaledVector(forward, move.z)
      .addScaledVector(right, move.x);
    if (wish.lengthSq() > 1) wish.normalize();

    const wantsSprint = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && move.z > 0;
    const canSprint = wantsSprint && this.stamina > 0.02;
    if (canSprint) {
      this.stamina = Math.max(0, this.stamina - dt * 0.34);
    } else {
      this.stamina = Math.min(1, this.stamina + dt * 0.24 * (move.z > 0 ? 1 : 1.6));
    }
    const speed = (canSprint ? SPRINT_SPEED : WALK_SPEED) * (0.55 + 0.45 * this.difficulty.stamina);
    const jump = keys.has('Space');

    this.body.update(dt, wish, { speed, jump, accel: 15 });

    // keep the eye exactly 1.62 m above whatever floor is under the player.
    // No head bob: it made the view wobble and caused motion sickness.
    const floorNow = this.body.grounded ? this.body.position.y : this.body.groundY(0.5);
    if (floorNow !== null) this.floorY = floorNow;
    this.syncCamera();

    // ---- safety net: never keep falling into the void ----
    // Snap back to the last place the player actually stood. This makes an
    // accidental ledge/void fall impossible, which also removes the
    // fall -> respawn loop that caused screen shake.
    const p = this.body.position;
    if (this.body.grounded) {
      this.safePosition = { x: p.x, y: p.y, z: p.z };
      this.airborneFrames = 0;
    } else if (this.safePosition && !jump) {
      this.airborneFrames += 1;
      if (this.airborneFrames > 6 && p.y < this.safePosition.y - 0.7) {
        this.body.teleport(this.safePosition.x, this.safePosition.y + 0.01, this.safePosition.z);
        this.body.velocity.set(0, 0, 0);
        this.body.resolve();
        this.syncCamera();
        this.airborneFrames = 0;
      }
    }

    // footsteps
    if (this.body.grounded && (move.x || move.z)) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = canSprint ? 0.32 : 0.46;
        sfx.step();
      }
    }

    // Falling out of the world is now prevented by the ledge guard; this is only
    // a last-resort recovery and it is debounced so it can never loop per frame.
    if (this.body.position.y < this.map.baseY - 4 && this.elapsed - this.lastRespawn > 1.5) {
      this.lastRespawn = this.elapsed;
      this.recover();
    }

    // ---------------- enemies (disabled for now) ----------------
    if (ENEMIES_ENABLED) {
      for (const enemy of this.enemies) {
        enemy.update(dt, this.body.position, (a, b) => this.lineOfSight(a, b), (damage) => this.hurt(damage));
      }
    }

    this.onHud(this.hudState());
  }

  lineOfSight(a, b) {
    return this.body.lineOfSight(a, b, 0.06);
  }

  /** reserved for when enemies are re-enabled */
  hurt(amount) {
    if (this.finished) return;
    this.health = Math.max(0, this.health - amount);
    sfx.damage();
    this.onEvent('damage', amount);
    this.onHud(this.hudState());
  }

  recover() {
    const spawn = this.map.spawn;
    this.body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
    this.body.velocity.set(0, 0, 0);
    this.body.resolve();
    const floor = this.body.groundY(0.6);
    if (floor !== null) {
      this.body.position.y = floor + 0.001;
      this.body.grounded = true;
      this.floorY = floor;
    }
    this.syncCamera();
    this.onEvent('toast', '開始地点に戻されました', 'bad');
  }

  setPaused(value) {
    this.paused = value;
    if (!value && this.clock) this.clock.last = performance.now() / 1000;
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  startLoop() {
    this.running = true;
    this.clock = { last: performance.now() / 1000 };
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const enemy of this.enemies) enemy.dispose(this.scene);
    this.enemies.length = 0;
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.collision?.geometry?.dispose?.();
    this.scene.clear();
  }
}
