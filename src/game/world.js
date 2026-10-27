// Three.js scene, lighting and the playable map instance.
import * as THREE from 'three';
import { CharacterController, PLAYER } from './physics.js';
import { Enemy, spawnEnemies } from './enemy.js';

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 800);
    this.camera.rotation.order = 'YXZ';

    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2a2a26, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe6c4, 1.05);
    this.sun.position.set(18, 26, 12);
    this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight(0x404a55, 0.55);
    this.scene.add(this.ambient);

    this.mapRoot = new THREE.Group();
    this.scene.add(this.mapRoot);
    this.enemies = [];
    this.controller = null;
    this.nav = null;
    this.current = null;
    this.clock = new THREE.Clock();
    this.bobTime = 0;

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async setMap(mapData) {
    this.clearMap();
    this.current = mapData;
    this.mapRoot.add(mapData.root);
    this.nav = mapData.nav;

    // tune the lights for the map's size so interiors are not pitch black
    const size = mapData.bounds.getSize(new THREE.Vector3());
    const indoor = size.y < 12;
    this.hemi.intensity = indoor ? 0.85 : 1.2;
    this.ambient.intensity = indoor ? 0.85 : 0.45;

    const spawn = mapData.spawn;
    this.controller = new CharacterController(mapData.collision.bvh, {
      height: mapData.def.player.height ?? PLAYER.height,
      eyeHeight: mapData.def.player.eyeHeight ?? PLAYER.eyeHeight,
      radius: mapData.def.player.radius ?? PLAYER.radius,
      step: mapData.def.player.step ?? PLAYER.step,
    });
    this.controller.teleport(spawn.position.x, spawn.position.y + 0.05, spawn.position.z);
    // settle onto the floor
    for (let i = 0; i < 8; i++) this.controller.update(1 / 60, { x: 0, z: 0 }, false, false);

    this.camera.position.set(
      spawn.position.x,
      this.controller.position.y + this.controller.p.eyeHeight,
      spawn.position.z,
    );
    this.camera.rotation.set(0, THREE.MathUtils.degToRad(spawn.yawDeg), 0);
    return this.controller.position.clone();
  }

  clearMap() {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies = [];
    if (this.current) {
      this.mapRoot.remove(this.current.root);
      this.current = null;
    }
    this.nav = null;
    this.controller = null;
  }

  startEnemies(difficulty) {
    this.enemies = spawnEnemies(
      this.scene,
      this.nav,
      this.current.collision.bvh,
      this.controller.position,
      difficulty,
      difficulty.enemies,
    );
    return this.enemies.length;
  }

  render(yaw, pitch, dt) {
    if (!this.controller) return;
    const p = this.controller.position;
    const speed = Math.hypot(this.controller.velocity.x, this.controller.velocity.z);
    if (this.controller.onGround && speed > 0.4) this.bobTime += dt * speed * 2.1;
    const bob = this.controller.onGround ? Math.sin(this.bobTime) * 0.022 * Math.min(1, speed / 4) : 0;
    this.camera.position.set(p.x, p.y + this.controller.p.eyeHeight + bob, p.z);
    if (yaw !== undefined) {
      this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    }
    this.renderer.render(this.scene, this.camera);
  }
}
