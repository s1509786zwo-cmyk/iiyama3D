import * as THREE from 'three';
import { MapAssetLoader, prepareMapScene, disposeObject } from '../core/Loader.js';
import { CollisionWorld } from '../core/CollisionWorld.js';
import { Player, PLAYER } from '../core/Player.js';
import { Enemy, pickEnemySpawn } from '../core/Enemy.js';
import { Input } from '../core/Input.js';
import { AudioBus } from '../core/Audio.js';

export const DIFFICULTIES = {
  easy: {
    id: 'easy',
    label: 'EASY',
    title: '記録係',
    enemyBonus: -1,
    speed: 0.82,
    damage: 7,
    detection: 0.85,
    itemBonus: -1,
    desc: 'ドローンは少なく鈍い。回収物も少なめ。',
  },
  normal: {
    id: 'normal',
    label: 'NORMAL',
    title: '調査員',
    enemyBonus: 0,
    speed: 1,
    damage: 12,
    detection: 1,
    itemBonus: 0,
    desc: '標準の難易度。ドローンが巡回し追跡してくる。',
  },
  hard: {
    id: 'hard',
    label: 'HARD',
    title: '侵入者',
    enemyBonus: 1,
    speed: 1.16,
    damage: 18,
    detection: 1.2,
    itemBonus: 1,
    desc: 'ドローンが増え、速く、執拗に追跡する。',
  },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Owns the renderer, the loaded map, the player and the run state.
 * One map is loaded at a time and disposed when another is chosen.
 */
export class GameApp {
  constructor(canvas, { save, audio } = {}) {
    this.canvas = canvas;
    this.save = save;
    this.audio = audio || new AudioBus();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 900);
    this.camera.rotation.order = 'YXZ';

    this.scene.fog = new THREE.FogExp2(0x0a0e12, 0.018);
    this.scene.background = new THREE.Color(0x070a0d);

    this.hemi = new THREE.HemisphereLight(0xc8d8e8, 0x2a231c, 1.05);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe6c4, 1.25);
    this.sun.position.set(18, 32, 12);
    this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight(0x8fa6b8, 0.45);
    this.scene.add(this.ambient);

    this.flashlight = new THREE.SpotLight(0xfff4e0, 34, 32, Math.PI / 5.4, 0.6, 1.4);
    this.flashlight.position.set(0, 0, 0);
    this.flashlight.target.position.set(0, 0, -1);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlight.target);
    this.scene.add(this.camera);

    this.input = new Input(canvas);
    this.player = new Player(this.camera, null);
    this.enemies = [];
    this.items = [];
    this.mapGroup = null;
    this.collision = null;
    this.currentMap = null;
    this.prepared = null;
    this.cells = [];
    this.spawnPoint = new THREE.Vector3();
    this.spawnYaw = 0;
    this.state = 'idle'; // idle | loading | playing | paused | ended
    this.difficulty = DIFFICULTIES.normal;
    this.elapsed = 0;
    this.collected = 0;
    this.totalItems = 0;
    this.exitZone = null;
    this.exitActive = false;
    this.inExit = false;
    this.lastHud = 0;
    this.loopHandle = null;
    this.clock = new THREE.Clock();
    this.onHud = null;
    this.onEvent = null;
    this.frames = 0;
    this.fpsWindow = { t: 0, frames: 0, fps: 0 };
    this.sensitivity = 1;

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();

    this.input.onLockChange = (locked) => {
      this.onLockChange?.(locked);
      if (!locked && this.state === 'playing') this.onEvent?.({ type: 'pointer-unlock' });
    };
    this.input.onEscape = () => {
      if (this.state === 'playing') this.onEvent?.({ type: 'pause-request' });
    };
    this.input.onClick = () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    };
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------ *
   * Map loading
   * ------------------------------------------------------------------ */

  async loadMap(mapDef, { onProgress, spacingOverride = null } = {}) {
    this.unloadMap();
    this.state = 'loading';
    const loader = new MapAssetLoader();
    const gltf = await loader.loadGLB(mapDef.file, (r) => onProgress?.(r * 0.75));
    const prepared = prepareMapScene(gltf, { scale: mapDef.scale, renderer: this.renderer });
    this.prepared = prepared;
    this.mapGroup = prepared.root;
    this.scene.add(prepared.root);
    onProgress?.(0.8);

    this.collision = new CollisionWorld(prepared.meshes);
    const box = prepared.box;
    this.mapBox = box.clone();

    // Walkable sampling drives spawn validation, item placement and patrol nodes.
    const planarDiag = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z);
    const spacing = spacingOverride || clamp(planarDiag / 55, 0.55, 1.6);
    this.cells = this.collision.sampleWalkable(box, {
      spacing,
      minClearance: PLAYER.height + 0.08,
      minClearanceLoose: 0.85,
      wallProbe: PLAYER.radius + 0.3,
      maxCells: 26000,
    });
    onProgress?.(0.9);

    const resolved = this._resolveSpawn(mapDef, box);
    this.spawnPoint.copy(resolved.position);
    this.spawnYaw = resolved.yaw;
    this.spawnSource = resolved.source;

    this.reachable = this._computeReachable(this.spawnPoint);
    this.player.collision = this.collision;
    this.camera.near = clamp((box.max.x - box.min.x) / 4000, 0.02, 0.4);
    this.camera.far = Math.max(200, box.getSize(new THREE.Vector3()).length() * 4);
    this.camera.updateProjectionMatrix();

    // Fog tuned to the map size so interiors stay readable.
    const diag = box.getSize(new THREE.Vector3()).length();
    this.scene.fog.density = clamp(2.4 / Math.max(diag, 6), 0.006, 0.05);

    this.currentMap = mapDef;
    onProgress?.(1);
    this.state = 'idle';
    return {
      stats: prepared.stats,
      spawn: this.spawnPoint.clone(),
      spawnSource: resolved.source,
      spawnYaw: this.spawnYaw,
      cells: this.cells.length,
      box,
    };
  }

  /**
   * Flood fill over the sampled floor grid starting at the spawn, so items and
   * enemies are only placed in the part of the map the player can actually
   * reach (no collectibles outside a train body or on a roof).
   */
  _computeReachable(spawn) {
    const cells = this.cells;
    if (!cells.length) return [];
    const open = cells.filter((c) => c.open);
    const pool = open.length ? open : cells;
    const stepX = Math.max(0.4, Math.min(...pool.map((c) => c.x)) === Infinity ? 0.6 : 0.6);
    // nearest cell to the spawn
    let start = pool[0];
    let bestD = Infinity;
    for (const c of pool) {
      const d = Math.hypot(c.x - spawn.x, c.z - spawn.z);
      if (d < bestD) { bestD = d; start = c; }
    }
    const key = (c) => `${Math.round(c.x / stepX)}:${Math.round(c.z / stepX)}`;
    const map = new Map();
    for (const c of pool) {
      const k = key(c);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
    const reachMax = 2.0;
    const visited = new Set([start]);
    const queue = [start];
    const out = [start];
    while (queue.length) {
      const c = queue.shift();
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (!dx && !dz) continue;
          const k = `${Math.round(c.x / stepX) + dx}:${Math.round(c.z / stepX) + dz}`;
          const list = map.get(k);
          if (!list) continue;
          for (const n of list) {
            if (visited.has(n)) continue;
            const dist = Math.hypot(n.x - c.x, n.z - c.z);
            if (dist > reachMax) continue;
            if (Math.abs(n.y - c.y) > 0.55) continue;
            visited.add(n);
            out.push(n);
            queue.push(n);
          }
        }
      }
    }
    if (out.length >= 8) return out;
    // Spawn sits in a tiny pocket - fall back to the whole sample.
    return pool;
  }

  _resolveSpawn(mapDef, box) {
    const center = box.getCenter(new THREE.Vector3());
    const cells = this.cells;
    if (mapDef.spawn && Number.isFinite(mapDef.spawn.x)) {
      const p = new THREE.Vector3(mapDef.spawn.x, mapDef.spawn.y ?? center.y, mapDef.spawn.z);
      const ground = this.collision.groundInfo(p.x, p.z, p.y + 3, 8);
      if (ground) p.y = ground.y;
      const blocked = this.collision.isBlocked(p, PLAYER.radius, PLAYER.height).blocked;
      const clearance = this.collision.ceilingInfo(p.x, p.z, p.y + 0.1, 8);
      if (!blocked && (!clearance || clearance.clearance > PLAYER.height + 0.1)) {
        return { position: p, yaw: mapDef.spawn.yaw ?? 0, source: 'registry' };
      }
    }

    if (cells.length) {
      const openCells = cells.filter((c) => c.open);
      const pool = openCells.length ? openCells : cells;
      // Ground level of the map - keeps the player off rooftops / catwalks.
      const floorYs = pool.map((c) => c.y).sort((a, b) => a - b);
      const p25 = floorYs[Math.floor(floorYs.length * 0.25)] ?? floorYs[0];
      const groundCells = pool.filter((c) => c.y <= p25 + 0.7);
      const base = groundCells.length > 3 ? groundCells : pool;
      // Indoors vs outdoors decides whether a ceiling is desirable.
      const roofed = base.filter((c) => c.clearance < 9).length;
      const indoor = roofed / base.length > 0.7;
      const preferred = base.filter((c) => (indoor ? c.clearance < 9 : c.clearance >= 3));
      const candidates = preferred.length > 2 ? preferred : base;

      // Final validation with the real player capsule: the spawn must have at
      // least 5 of 8 directions open so the player is never wedged.
      const reach = PLAYER.radius + 0.06;
      const roomyReach = PLAYER.radius + 0.45;
      const scored = candidates.map((c) => {
        const p = new THREE.Vector3(c.x, c.y, c.z);
        return {
          c,
          dirs: this.collision.freeDirections(p, reach, PLAYER.height),
          room: this.collision.freeDirections(p, roomyReach, PLAYER.height),
        };
      });
      const roomy = scored.filter((e) => e.dirs >= 6 && e.room >= 6);
      const free = (roomy.length ? roomy : scored.filter((e) => e.dirs >= 5))
        .sort((a, b) => (b.room + b.dirs) - (a.room + a.dirs))
        .map((e) => e.c);
      const pool2 = free.length ? free : candidates;
      const dirsOf = new Map(scored.map((e) => [e.c, e.room * 1.4 + e.dirs]));

      let best = null;
      let bestScore = -Infinity;
      for (const c of pool2) {
        const dist = Math.hypot(c.x - center.x, c.z - center.z);
        const clearance = Math.min(c.clearance, 6);
        const score = clearance * 1.4 - dist * 0.35 + (dirsOf.get(c) || 0) * 1.1;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      const p = new THREE.Vector3(best.x, best.y, best.z);
      // Face the map centre so the player looks into the scene, not at a wall.
      const yaw = Math.atan2(-(center.x - p.x), -(center.z - p.z));
      return { position: p, yaw: mapDef.spawn?.yaw ?? yaw, source: indoor ? 'auto-indoor' : 'auto-outdoor' };
    }

    return { position: new THREE.Vector3(center.x, box.min.y, center.z), yaw: 0, source: 'fallback-center' };
  }

  unloadMap() {
    this.stopLoop();
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      disposeObject(this.mapGroup);
      this.mapGroup = null;
    }
    for (const e of this.enemies) this.scene.remove(e.mesh);
    this.enemies = [];
    this._clearActors();
    this.prepared = null;
    this.collision = null;
    this.cells = [];
    this.currentMap = null;
    this.state = 'idle';
  }

  /* ------------------------------------------------------------------ *
   * Session
   * ------------------------------------------------------------------ */

  start(difficultyId = 'normal') {
    if (!this.collision) throw new Error('No map loaded');
    this.difficulty = DIFFICULTIES[difficultyId] || DIFFICULTIES.normal;
    this._clearActors();

    this.player.spawn(this.spawnPoint.clone().setY(this.spawnPoint.y + 0.05), this.spawnYaw);
    this.player.enabled = true;
    this.player.health = 100;

    this._placeItems();
    this._placeEnemies();
    this._createExit();

    this.elapsed = 0;
    this.collected = 0;
    this.exitActive = false;
    this.inExit = false;
    this.state = 'playing';
    this.clock.getDelta();
    this._pushHud(true);
    this.startLoop();
    return { items: this.items.length, enemies: this.enemies.length };
  }

  _clearActors() {
    for (const e of this.enemies) {
      this.scene.remove(e.mesh);
      e.mesh.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
    }
    this.enemies = [];
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      it.mesh.geometry.dispose();
      it.mesh.material.dispose();
      if (it.halo) {
        this.scene.remove(it.halo);
        it.halo.geometry.dispose();
        it.halo.material.dispose();
      }
    }
    this.items = [];
    if (this.exitZone) {
      this.scene.remove(this.exitZone);
      this.exitZone.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      this.exitZone = null;
      this.exitRing = null;
      this.exitPillar = null;
    }
  }

  _placeItems() {
    const count = clamp((this.currentMap.gameplay.items || 4) + this.difficulty.itemBonus, 2, 9);
    const base = this.reachable?.length ? this.reachable : this.cells;
    const candidates = base.filter((c) => Math.hypot(c.x - this.spawnPoint.x, c.z - this.spawnPoint.z) > 2.6);
    const chosen = [];
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    for (const c of shuffled) {
      if (chosen.length >= count) break;
      if (chosen.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 2.6)) continue;
      chosen.push(c);
    }
    if (chosen.length < count) {
      for (const c of shuffled) {
        if (chosen.length >= count) break;
        if (!chosen.includes(c)) chosen.push(c);
      }
    }

    const geo = new THREE.OctahedronGeometry(0.16, 0);
    for (const c of chosen) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2ad9c0,
        emissive: 0x0fbfa6,
        emissiveIntensity: 1.5,
        roughness: 0.25,
        metalness: 0.35,
      });
      const mesh = new THREE.Mesh(geo.clone(), mat);
      mesh.position.set(c.x, c.y + 0.85, c.z);
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.22, 0.3, 20),
        new THREE.MeshBasicMaterial({ color: 0x6ffbe0, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.set(c.x, c.y + 0.03, c.z);
      this.scene.add(halo);
      this.scene.add(mesh);
      this.items.push({ mesh, halo, base: c.y + 0.85, collected: false });
    }
    this.totalItems = this.items.length;
  }

  _placeEnemies() {
    const base = this.currentMap.gameplay.enemies ?? 2;
    const count = clamp(base + this.difficulty.enemyBonus, 0, 6);
    const nodesSrc = this.reachable?.length ? this.reachable : this.cells;
    const walkNodes = nodesSrc.map((c) => new THREE.Vector3(c.x, c.y + 0.9, c.z));
    const farthest = walkNodes.reduce((m, n) => Math.max(m, n.distanceTo(this.spawnPoint)), 0);
    for (let i = 0; i < count; i++) {
      const minDist = Math.min(Math.max(6, 8 - i), Math.max(1.5, farthest * 0.55));
      const spawn = pickEnemySpawn(walkNodes, this.spawnPoint, minDist) || this.spawnPoint.clone().add(new THREE.Vector3(2, 0, 0));
      const enemy = new Enemy(this.collision, {
        nodes: walkNodes,
        spawn,
        speed: 1.75,
        damage: this.difficulty.damage,
        detectionRange: 15 * this.difficulty.detection,
        difficultyScale: this.difficulty.speed,
      });
      this.scene.add(enemy.mesh);
      this.enemies.push(enemy);
    }
  }

  _createExit() {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.15, 1.35, 40),
      new THREE.MeshBasicMaterial({ color: 0x6ffbe0, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 3.2, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x6ffbe0, transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
    );
    pillar.position.y = 1.6;
    group.add(pillar);
    group.position.set(this.spawnPoint.x, this.spawnPoint.y + 0.02, this.spawnPoint.z);
    group.visible = false;
    this.exitZone = group;
    this.exitRing = ring;
    this.exitPillar = pillar;
    this.scene.add(group);
  }

  /* ------------------------------------------------------------------ *
   * Loop
   * ------------------------------------------------------------------ */

  startLoop() {
    if (this.loopHandle) return;
    const tick = () => {
      this.loopHandle = requestAnimationFrame(tick);
      this.frame();
    };
    this.loopHandle = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.loopHandle) cancelAnimationFrame(this.loopHandle);
    this.loopHandle = null;
  }

  frame() {
    const dtRaw = this.clock.getDelta();
    const dt = Math.min(dtRaw, 0.05);
    const time = this.clock.elapsedTime;

    if (this.state === 'playing') {
      const { dx, dy } = this.input.consumeMouse();
      if (this.input.locked) this.player.look(dx, dy, this.sensitivity);
      this.player.update(dt, this.input);
      this.elapsed += dt;
      this._updateActors(dt, time);
      this._updateItems(time, dt);
      this._updateExit(time);
      this._pushHud(false);
    } else {
      this.input.consumeMouse();
      if (this.state === 'paused' || this.state === 'ended') {
        // Keep the scene alive but frozen.
        this.player.syncCamera(dt);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.input.endFrame();
  }

  _updateActors(dt, time) {
    let damaged = 0;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      enemy.update(dt, this.player.position, time);
      const dist = enemy.position.distanceTo(this.player.position);
      const dmg = enemy.tryAttack(dist);
      if (dmg > 0 && this.difficulty.damage > 0) {
        damaged += dmg;
        this.onEvent?.({ type: 'damage', amount: dmg, enemy });
      }
    }
    if (damaged > 0) {
      this.player.health = Math.max(0, this.player.health - damaged);
      this.audio.hurt();
      if (this.player.health <= 0) this._end(false);
    }
  }

  _updateItems(time) {
    for (const item of this.items) {
      if (item.collected) continue;
      item.mesh.rotation.y += 0.02;
      item.mesh.position.y = item.base + Math.sin(time * 2.2) * 0.08;
      if (item.halo) item.halo.material.opacity = 0.3 + Math.sin(time * 3) * 0.14;
      const dx = item.mesh.position.x - this.player.position.x;
      const dy = item.mesh.position.y - (this.player.position.y + 0.9);
      const dz = item.mesh.position.z - this.player.position.z;
      if (dx * dx + dy * dy + dz * dz < 1.5 * 1.5) {
        item.collected = true;
        item.mesh.visible = false;
        if (item.halo) item.halo.visible = false;
        this.collected++;
        this.audio.pickup();
        this.onEvent?.({ type: 'pickup', collected: this.collected, total: this.totalItems });
        if (this.collected >= this.totalItems) {
          this.exitActive = true;
          if (this.exitZone) this.exitZone.visible = true;
          this.onEvent?.({ type: 'all-collected' });
        }
      }
    }
  }

  _updateExit(time) {
    if (!this.exitZone) return;
    this.exitRing.material.opacity = this.exitActive ? 0.55 + Math.sin(time * 2.4) * 0.18 : 0.2;
    this.exitPillar.material.opacity = this.exitActive ? 0.16 + Math.sin(time * 2) * 0.05 : 0.06;
    if (!this.exitActive) return;
    const d = Math.hypot(this.player.position.x - this.spawnPoint.x, this.player.position.z - this.spawnPoint.z);
    const inside = d < 2.0;
    if (inside && !this.inExit) {
      this.inExit = true;
      this._end(true);
    } else if (!inside) {
      this.inExit = false;
    }
  }

  _pushHud(force) {
    const now = performance.now();
    if (!force && now - this.lastHud < 90) return;
    this.lastHud = now;
    this.fpsWindow.frames++;
    if (now - this.fpsWindow.t > 500) {
      this.fpsWindow.fps = Math.round((this.fpsWindow.frames * 1000) / (now - this.fpsWindow.t));
      this.fpsWindow.frames = 0;
      this.fpsWindow.t = now;
    }
    this.onHud?.({
      health: this.player.health,
      stamina: this.player.stamina,
      elapsed: this.elapsed,
      collected: this.collected,
      total: this.totalItems,
      exitActive: this.exitActive,
      fps: this.fpsWindow.fps,
      triangles: this.renderer.info.render.triangles,
      mapTitle: this.currentMap?.title || '',
    });
  }

  _end(escaped) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.player.enabled = false;
    this.input.exitLock();
    if (escaped) this.audio.escape();
    else this.audio.fail();
    const score = this.save?.recordRun({
      mapId: this.currentMap.id,
      difficulty: this.difficulty.id,
      seconds: this.elapsed,
      escaped,
      collected: this.collected,
      total: this.totalItems,
    });
    this.onEvent?.({ type: escaped ? 'escape' : 'die', elapsed: this.elapsed, collected: this.collected, total: this.totalItems, entry: score });
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.player.enabled = false;
    this.input.exitLock();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.player.enabled = true;
    this.clock.getDelta();
    this.input.requestLock();
  }

  restart() {
    if (!this.currentMap) return;
    this.start(this.difficulty.id);
  }

  /** Positions used by tests / debugging. */
  describe() {
    return {
      mapId: this.currentMap?.id,
      state: this.state,
      spawn: this.spawnPoint.toArray(),
      spawnSource: this.spawnSource,
      spawnYaw: this.spawnYaw,
      box: this.mapBox ? { min: this.mapBox.min.toArray(), max: this.mapBox.max.toArray() } : null,
      cells: this.cells.length,
      items: this.items.map((i) => i.mesh.position.toArray()),
      enemies: this.enemies.map((e) => e.position.toArray()),
      scale: this.prepared?.stats.scale,
      stats: this.prepared?.stats
        ? {
            triangles: this.prepared.stats.triangles,
            vertices: this.prepared.stats.vertices,
            textures: this.prepared.stats.textures,
            materials: this.prepared.stats.materials,
          }
        : null,
    };
  }
}
