// Loads map assets (GLB model, collision mesh, nav grid) and tracks per-map state so the
// map-select screen can show a truthful loading status for each map.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { NavGrid } from './nav.js';

export const STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
};

export class MapLibrary {
  constructor() {
    this.draco = new DRACOLoader();
    this.draco.setDecoderPath('/vendor/draco/');
    this.gltf = new GLTFLoader();
    this.gltf.setDRACOLoader(this.draco);
    /** @type {Map<string, {status:string, progress:number, error?:string, data?:any}>} */
    this.state = new Map();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(id) {
    const s = this.state.get(id);
    for (const fn of this.listeners) fn(id, s);
  }

  entry(id) {
    if (!this.state.has(id)) this.state.set(id, { status: STATUS.IDLE, progress: 0 });
    return this.state.get(id);
  }

  async loadMap(def) {
    const cur = this.entry(def.id);
    if (cur.status === STATUS.LOADING) return cur.promise;
    if (cur.status === STATUS.READY) return cur.data;
    this.state.set(def.id, { status: STATUS.LOADING, progress: 0, promise: null });
    const promise = this._load(def).then(
      (data) => {
        this.state.set(def.id, { status: STATUS.READY, progress: 1, data });
        this.emit(def.id);
        return data;
      },
      (err) => {
        console.error(`[map:${def.id}] load failed`, err);
        this.state.set(def.id, {
          status: STATUS.ERROR,
          progress: 1,
          error: err?.message || String(err),
        });
        this.emit(def.id);
        throw err;
      },
    );
    this.state.get(def.id).promise = promise;
    this.emit(def.id);
    return promise;
  }

  async _load(def) {
    const gltf = await new Promise((resolve, reject) => {
      this.gltf.load(
        encodeURI(def.model),
        resolve,
        (ev) => {
          if (ev && ev.total) {
            const e = this.entry(def.id);
            if (e.status === STATUS.LOADING) {
              e.progress = Math.min(0.99, ev.loaded / ev.total);
              this.emit(def.id);
            }
          }
        },
        (err) => reject(new Error(`モデルを読み込めません: ${err?.message || def.model}`)),
      );
    });

    // Per-map placement: uniform scale, rotation, then baked offset so that the map's
    // spawn point sits exactly at the world origin on the floor (y = 0).
    const root = gltf.scene;
    const scale = def.scale;
    const rot = def.rotationDeg.map((d) => THREE.MathUtils.degToRad(d));
    root.scale.setScalar(scale);
    root.rotation.set(rot[0], rot[1], rot[2], 'XYZ');
    root.position.set(def.offset[0], def.offset[1], def.offset[2]);
    root.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(root);
    const box = bounds.clone();

    // collision mesh (already authored in final world space)
    const colGltf = await new Promise((resolve, reject) => {
      this.gltf.load(
        encodeURI(def.collision),
        resolve,
        undefined,
        (err) => reject(new Error(`衝突判定を読み込めません: ${err?.message || def.collision}`)),
      );
    });
    const colMesh = findFirstMesh(colGltf.scene);
    if (!colMesh) throw new Error('衝突判定メッシュが見つかりません');
    const colGeometry = colMesh.geometry.clone();
    colGeometry.computeBoundingBox();
    const bvh = new MeshBVH(colGeometry);

    // nav grid
    let nav = null;
    if (def.nav) {
      const r = await fetch(def.nav, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`ナビグリッドを読み込めません (${r.status})`);
      nav = new NavGrid(await r.json());
    }

    let tris = 0;
    let meshes = 0;
    let materials = new Set();
    let textures = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const idx = o.geometry.index;
      tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        materials.add(m.uuid);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap']) {
          if (m[k]) textures.add(m[k].uuid);
        }
      }
    });

    return {
      def,
      root,
      bounds: box,
      collision: { geometry: colGeometry, bvh },
      nav,
      stats: { meshes, triangles: Math.round(tris), materials: materials.size, textures: textures.size },
      spawn: {
        position: new THREE.Vector3(...def.spawn.position),
        yawDeg: def.spawn.yawDeg,
      },
    };
  }

  dispose(def) {
    const s = this.state.get(def.id);
    if (s?.data) {
      s.data.root.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
            for (const k of Object.keys(m)) {
              const v = m[k];
              if (v && v.isTexture) v.dispose();
            }
            m.dispose?.();
          }
        }
      });
      s.data.collision?.geometry?.dispose?.();
    }
    this.state.delete(def.id);
  }
}

function findFirstMesh(obj) {
  let found = null;
  obj.traverse((o) => {
    if (!found && o.isMesh) found = o;
  });
  return found;
}
