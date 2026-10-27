/**
 * A single playthrough on one map.
 * Owns the three.js scene, the player, enemies, objectives and the game loop.
 */
import {
  Scene, PerspectiveCamera, Color, Fog, HemisphereLight, DirectionalLight,
  AmbientLight, SpotLight, SpotLightHelper, Object3D, Vector3, Mesh,
  OctahedronGeometry, RingGeometry, TorusGeometry, MeshBasicMaterial,
  MeshStandardMaterial, PointLight, Group, AdditiveBlending, DoubleSide,
  PMREMGenerator,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadMapModel, buildMapCollision, disposeModel } from '../core/assets.js';
import { CharacterBody, NavGrid } from '../core/collision.js';
import { Enemy } from './enemy.js';
import { sfx } from '../core/audio.js';
import { formatTime } from '../core/save.js';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 3.15;
const SPRINT_SPEED = 5.5;
const PLAYER_RADIUS = 0.24;
const PLAYER_HEIGHT = 1.75;

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
    this.camera = new PerspectiveCamera(74, 1, 0.05, 500);
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
    this.fragments = [];
    this.collected = 0;
    this.health = difficulty.health;
    this.maxHealth = difficulty.health;
    this.stamina = 1;
    this.exitActive = false;
    this.exitPulse = 0;
    this.stepTimer = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = save?.settings?.sensitivity ?? 1;
    this.invertY = save?.settings?.invertY ?? false;
    this.timeScale = 1;
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
    this.setupFragments();
    this.setupExit();
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

    this.ambient = new AmbientLight(0x6f8492, 0.35);
    this.scene.add(this.ambient);

    this.sun = new DirectionalLight(new Color(map.sunColor || '#c8d4dc'), map.sunIntensity ?? 1.2);
    const center = this.bounds.getCenter(new Vector3());
    this.sun.position.copy(center).add(new Vector3(12, 26, 9));
    this.sun.target.position.copy(center);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // flashlight — the only reliable light source inside these buildings
    this.flashlight = new SpotLight(0xfff0d0, 26, 34, Math.PI / 7, 0.55, 1.4);
    this.flashlight.position.set(0.18, -0.12, 0.1);
    this.flashlightTarget = new Object3D();
    this.flashlightTarget.position.set(0, 0, -1);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;
    this.scene.add(this.camera);

    this.eyeLight = new PointLight(0x9fd0d8, 0.9, 6, 2);
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
    this.yaw = spawn.yaw ?? 0;
    this.pitch = 0;
    this.syncCamera();
  }

  setupFragments() {
    const geo = new OctahedronGeometry(0.15, 0);
    const ringGeo = new RingGeometry(0.28, 0.38, 24);
    this.map.objectives.forEach((point, i) => {
      const group = new Group();
      group.position.set(point.x, point.y + 0.9, point.z);

      const core = new Mesh(geo, new MeshStandardMaterial({
        color: 0xffd18a, emissive: new Color(0xffa63d), emissiveIntensity: 2.4,
        metalness: 0.3, roughness: 0.25,
      }));
      group.add(core);

      const halo = new Mesh(geo, new MeshBasicMaterial({
        color: 0xffc06a, transparent: true, opacity: 0.24,
        blending: AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(2.1);
      group.add(halo);

      const light = new PointLight(0xffb255, 2.2, 4.2, 2);
      group.add(light);

      const ring = new Mesh(ringGeo, new MeshBasicMaterial({
        color: 0xffb455, transparent: true, opacity: 0.5, side: DoubleSide,
        blending: AdditiveBlending, depthWrite: false,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(point.x, point.y + 0.03, point.z);
      this.scene.add(ring);

      this.scene.add(group);
      this.fragments.push({ group, ring, core, halo, light, point, index: i, taken: false, phase: i * 1.7 });
    });
  }

  setupExit() {
    const spawn = this.map.spawn;
    this.exitGroup = new Group();
    this.exitGroup.position.set(spawn.x, spawn.y + 1.1, spawn.z);

    this.exitRing = new Mesh(
      new TorusGeometry(0.85, 0.045, 8, 40),
      new MeshStandardMaterial({
        color: 0x4fe0c0, emissive: new Color(0x2fd0ae), emissiveIntensity: 1.2,
        transparent: true, opacity: 0.55, roughness: 0.4,
      }),
    );
    this.exitGroup.add(this.exitRing);

    this.exitGlow = new Mesh(
      new RingGeometry(0.5, 0.95, 32),
      new MeshBasicMaterial({
        color: 0x4fe0c0, transparent: true, opacity: 0.12,
        side: DoubleSide, blending: AdditiveBlending, depthWrite: false,
      }),
    );
    this.exitGlow.rotation.x = -Math.PI / 2;
    this.exitGlow.position.y = -1.05;
    this.exitGroup.add(this.exitGlow);
    this.scene.add(this.exitGroup);
  }

  setupEnemies() {
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
    this.camera.position.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  hudState() {
    return {
      health: this.health,
      maxHealth: this.maxHealth,
      stamina: this.stamina,
      collected: this.collected,
      total: this.fragments.length,
      time: this.elapsed,
      exitActive: this.exitActive,
      yaw: this.yaw,
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
    this.syncCamera();

    // footsteps
    if (this.body.grounded && (move.x || move.z)) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = canSprint ? 0.32 : 0.46;
        sfx.step();
      }
    }

    // fell out of the map -> respawn safely
    if (this.body.position.y < this.map.baseY - 9) {
      this.respawn();
    }

    // ---------------- objectives ----------------
    for (const fragment of this.fragments) {
      if (fragment.taken) continue;
      fragment.phase += dt;
      fragment.group.rotation.y += dt * 1.5;
      fragment.group.position.y = fragment.point.y + 0.9 + Math.sin(fragment.phase * 1.8) * 0.09;
      fragment.halo.scale.setScalar(2.1 + Math.sin(fragment.phase * 2.4) * 0.16);
      fragment.ring.material.opacity = 0.32 + Math.sin(fragment.phase * 2.2) * 0.12;

      const distance = Math.hypot(
        this.body.position.x - fragment.point.x,
        this.body.position.z - fragment.point.z,
      );
      if (distance < 1.25 && Math.abs(this.body.position.y - fragment.point.y) < 2) {
        this.collectFragment(fragment);
      }
    }

    // ---------------- exit ----------------
    if (this.exitActive) {
      this.exitPulse += dt;
      this.exitRing.rotation.y += dt * 0.7;
      const pulse = 1 + Math.sin(this.exitPulse * 2.2) * 0.05;
      this.exitRing.scale.setScalar(pulse);
      this.exitRing.material.opacity = 0.5 + Math.sin(this.exitPulse * 2.2) * 0.15;
      const d = Math.hypot(
        this.body.position.x - this.map.spawn.x,
        this.body.position.z - this.map.spawn.z,
      );
      if (d < 1.35 && Math.abs(this.body.position.y - this.map.spawn.y) < 2.4) {
        this.finish(true);
      }
    } else {
      this.exitRing.rotation.y += dt * 0.25;
    }

    // ---------------- enemies ----------------
    for (const enemy of this.enemies) {
      enemy.update(dt, this.body.position, (a, b) => this.lineOfSight(a, b), (damage) => this.hurt(damage));
    }

    this.onHud(this.hudState());
  }

  lineOfSight(a, b) {
    return this.body.lineOfSight(a, b, 0.06);
  }

  collectFragment(fragment) {
    fragment.taken = true;
    this.collected += 1;
    this.scene.remove(fragment.group);
    this.scene.remove(fragment.ring);
    sfx.pickup();
    this.onEvent('toast', `記録を回収した（${this.collected}/${this.fragments.length}）`);
    if (this.collected >= this.fragments.length) {
      this.exitActive = true;
      this.exitRing.material.opacity = 0.75;
      this.exitGlow.material.opacity = 0.34;
      this.onEvent('toast', 'すべて回収した ─ 脱出地点へ戻れ', 'warn');
      sfx.escape();
    }
    this.onHud(this.hudState());
  }

  hurt(amount) {
    if (this.finished) return;
    this.health -= amount;
    sfx.damage();
    this.onEvent('damage', amount);
    this.onHud(this.hudState());
    if (this.health <= 0) {
      this.health = 0;
      this.finish(false);
    }
  }

  respawn() {
    const spawn = this.map.spawn;
    this.body.teleport(spawn.x, spawn.y + 0.05, spawn.z);
    this.body.resolve();
    this.syncCamera();
    this.onEvent('toast', '落下した ─ 開始地点に戻された', 'bad');
  }

  finish(escaped) {
    if (this.finished) return;
    this.finished = true;
    const stats = {
      escaped,
      time: this.elapsed,
      fragments: this.collected,
      total: this.fragments.length,
      mapId: this.map.id,
      difficultyId: this.difficulty.id,
      timeLabel: formatTime(this.elapsed),
    };
    if (escaped) sfx.escape();
    else sfx.fail();
    if (escaped) this.onWin(stats);
    else this.onLose(stats);
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
    for (const fragment of this.fragments) {
      this.scene.remove(fragment.group);
      this.scene.remove(fragment.ring);
    }
    this.fragments.length = 0;
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.collision?.geometry?.dispose?.();
    this.scene.clear();
  }
}
