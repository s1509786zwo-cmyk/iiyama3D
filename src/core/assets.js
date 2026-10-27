/**
 * Map asset loading, preview rendering and the offline cache.
 *
 * The GLB files live in `public/maps/` inside the project, so the game never
 * touches Google Drive at runtime.
 */
import {
  Box3, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene,
  SRGBColorSpace, ACESFilmicToneMapping, Vector3, WebGLRenderer,
  DoubleSide, MeshStandardMaterial,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildCollision } from './collision.js';

export const ASSET_VERSION = '1'; // bump when public/maps changes, invalidates preview cache
const BASE = import.meta.env.BASE_URL || './';
const THUMB_W = 560;
const THUMB_H = 350;

const urlFor = (map) => `${BASE}${map.file.replace(/^\/+/, '')}`;

/* ------------------------------------------------------------------ */
/* tiny IndexedDB wrapper (thumbnail + verification cache)             */
/* ------------------------------------------------------------------ */
const DB_NAME = 'iiyama3d-cache';
const STORE = 'map-previews';
let dbPromise = null;
const memCache = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        if (req.result) memCache.set(key, req.result);
        resolve(req.result || null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheSet(key, value) {
  memCache.set(key, value);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
  } catch { /* cache is best-effort */ }
}

const cacheKey = (map) => `${ASSET_VERSION}::${map.id}`;

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/**
 * Load a map GLB, apply its calibrated uniform scale and prepare materials.
 * @returns {Promise<{root: import('three').Group, box: Box3, size: Vector3}>}
 */
export async function loadMapModel(map, { onProgress } = {}) {
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      urlFor(map),
      resolve,
      (evt) => {
        if (onProgress) onProgress({ loaded: evt.loaded, total: evt.total || 0 });
      },
      (err) => reject(new Error(`failed to load ${map.file}: ${err?.message || err}`)),
    );
  });

  const root = gltf.scene;
  root.name = map.id;
  // uniform scale from the per-map unit calibration (never non-uniform)
  root.scale.setScalar(map.scale);
  root.updateMatrixWorld(true);

  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.frustumCulled = true;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      // models are authored single sided; keep transparency behaviour intact
      if (material.transparent && material.opacity >= 0.999 && !material.alphaTest) {
        material.transparent = false;
        material.depthWrite = true;
      }
      material.shadowSide = DoubleSide;
      material.needsUpdate = true;
    }
  });

  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  return { root, box, size, gltf };
}

/** Build the collision BVH for an already-loaded model. */
export function buildMapCollision(root) {
  root.updateMatrixWorld(true);
  return buildCollision(root);
}

/* ------------------------------------------------------------------ */
/* preview rendering (a real render of the real model)                 */
/* ------------------------------------------------------------------ */
export function renderPreview(root, map, box, size) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(THUMB_W, THUMB_H, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(new Color(map.fogColor || '#0b0f12'), 1);

  const scene = new Scene();
  scene.add(root);

  const hemi = new HemisphereLight(0xbcd4dd, 0x1b2228, 1.5);
  scene.add(hemi);
  const key = new DirectionalLight(0xffffff, 2.1);
  const center = box.getCenter(new Vector3());
  const radius = Math.max(size.length() * 0.5, 0.6);
  key.position.copy(center).add(new Vector3(radius, radius * 1.6, radius * 0.9));
  scene.add(key);
  const fill = new DirectionalLight(map.sunColor || 0x8899aa, 0.9);
  fill.position.copy(center).add(new Vector3(-radius, radius * 0.7, -radius));
  scene.add(fill);
  scene.add(new HemisphereLight(0xffffff, 0x000000, 0.25));

  const camera = new PerspectiveCamera(42, THUMB_W / THUMB_H, 0.05, radius * 40);
  const hint = new Vector3(...(map.thumbHint || [1, 0.6, 1])).normalize();
  const distance = radius / Math.sin((42 * Math.PI) / 360) * 1.02;
  camera.position.copy(center).addScaledVector(hint, distance);
  camera.lookAt(center);

  // a couple of interior spots so dark rooms are not pitch black in the preview
  const spotA = new DirectionalLight(0xffffff, 0.6);
  spotA.position.copy(center).add(new Vector3(0, radius * 2, 0));
  scene.add(spotA);

  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');

  // detach so the caller can dispose the model independently
  scene.remove(root);
  key.dispose?.(); fill.dispose?.(); hemi.dispose?.(); spotA.dispose?.();
  renderer.dispose();
  renderer.forceContextLoss();

  return dataUrl;
}

/** dispose geometry/material/texture of a loaded map */
export function disposeModel(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && value.isTexture) value.dispose();
      }
      material.dispose?.();
    }
  });
}

/**
 * Load a map purely to validate it and produce its preview image.
 * Frees all GPU memory afterwards.
 * @returns {Promise<{ok:boolean, thumb?:string, bytes?:number, error?:string}>}
 */
export async function probeMap(map, { onProgress } = {}) {
  const key = cacheKey(map);
  const cached = await cacheGet(key);
  if (cached && cached.ok && cached.thumb) return cached;

  let loaded;
  try {
    loaded = await loadMapModel(map, { onProgress });
  } catch (error) {
    const failure = { ok: false, error: String(error?.message || error), at: Date.now() };
    await cacheSet(key, failure);
    return failure;
  }

  try {
    const thumb = renderPreview(loaded.root, map, loaded.box, loaded.size);
    const result = {
      ok: true,
      thumb,
      triCount: countTriangles(loaded.root),
      at: Date.now(),
      bounds: {
        min: loaded.box.min.toArray().map((n) => +n.toFixed(2)),
        max: loaded.box.max.toArray().map((n) => +n.toFixed(2)),
      },
    };
    await cacheSet(key, result);
    return result;
  } catch (error) {
    const failure = { ok: false, error: `preview failed: ${error?.message || error}`, at: Date.now() };
    await cacheSet(key, failure);
    return failure;
  } finally {
    disposeModel(loaded.root);
  }
}

export function countTriangles(root) {
  let triangles = 0;
  root.traverse((child) => {
    if (!child.isMesh) return;
    const geo = child.geometry;
    if (!geo) return;
    triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  });
  return Math.round(triangles);
}

export function clearPreviewCache(map) {
  memCache.delete(cacheKey(map));
  openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(cacheKey(map));
    } catch { /* ignore */ }
  });
}

/** cached preview for a map, if present (used by the difficulty screen) */
export async function getCachedPreview(map) {
  const cached = await cacheGet(cacheKey(map));
  return cached && cached.ok ? cached : null;
}
