import * as THREE from 'three';
import { MapAssetLoader, prepareMapScene, disposeObject } from '../core/Loader.js';
import { CollisionWorld } from '../core/CollisionWorld.js';

/**
 * Bounding box of the actual geometry mass. A plain AABB is often dominated by
 * a large flat ground slab or a few stray vertices, which makes the model look
 * tiny in the thumbnail; percentile bounds of the vertices avoid that.
 */
function contentBox(root) {
  const xs = [];
  const ys = [];
  const zs = [];
  const v = new THREE.Vector3();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const pos = obj.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  });
  if (!xs.length) return new THREE.Box3().setFromObject(root);
  const q = (arr, p) => {
    const sorted = arr.sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  };
  return new THREE.Box3(
    new THREE.Vector3(q(xs, 0.01), q(ys, 0.01), q(zs, 0.01)),
    new THREE.Vector3(q(xs, 0.99), q(ys, 0.99), q(zs, 0.99)),
  );
}

/**
 * Places the camera so the whole bounding box fills `fill` of the frame.
 * A sphere fit always looks too far away for wide, flat scenes, so the box
 * corners are projected and the distance is refined iteratively.
 */
function frameBox(camera, box, dir, fill = 0.92) {
  const center = box.getCenter(new THREE.Vector3());
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ));
  }
  let dist = Math.max(1e-3, box.getSize(new THREE.Vector3()).length());
  const v = new THREE.Vector3();
  for (let iter = 0; iter < 6; iter++) {
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    let maxNdc = 0;
    for (const c of corners) {
      v.copy(c).project(camera);
      maxNdc = Math.max(maxNdc, Math.abs(v.x), Math.abs(v.y));
    }
    if (!Number.isFinite(maxNdc) || maxNdc <= 1e-6) break;
    const factor = maxNdc / fill;
    if (Math.abs(factor - 1) < 0.01) break;
    dist *= factor;
  }
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
}

const DB_NAME = 'iiyama3d-assets';
const STORE = 'previews';

function openDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function cacheGet(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function cacheSet(key, blob) {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Renders a thumbnail of the real GLB so the map select screen never shows a
 * placeholder or a stand-in image. Results are cached in IndexedDB.
 */
export class PreviewGenerator {
  constructor({ width = 512, height = 320 } = {}) {
    this.width = width;
    this.height = height;
    this.loader = new MapAssetLoader();
    this.renderer = null;
  }

  _ensureRenderer() {
    if (this.renderer) return this.renderer;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(this.width, this.height, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    this.renderer = renderer;
    return renderer;
  }

  async generate(map, { onProgress, refresh = false } = {}) {
    const key = `${map.id}:${map.source?.md5 || map.source?.bytes || map.file}`;
    const cached = refresh ? null : await cacheGet(key);
    if (cached) {
      map.previewUrl = URL.createObjectURL(cached);
      return map.previewUrl;
    }

    const gltf = await this.loader.loadGLB(map.file, (r) => onProgress?.(r));
    const prepared = prepareMapScene(gltf, { scale: map.scale, anisotropy: 4 });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1014);
    scene.add(prepared.root);

    const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x2a2118, 1.1);
    scene.add(hemi);
    const boxScale = Math.max(1, prepared.box.getSize(new THREE.Vector3()).length());
    const dir = new THREE.DirectionalLight(0xfff0d8, 2.6);
    dir.position.copy(prepared.box.getCenter(new THREE.Vector3())).add(new THREE.Vector3(0.8, 1.3, 0.6).multiplyScalar(boxScale));
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88bbff, 1.1);
    fill.position.copy(prepared.box.getCenter(new THREE.Vector3())).add(new THREE.Vector3(-0.9, 0.5, -0.7).multiplyScalar(boxScale));
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.copy(prepared.box.getCenter(new THREE.Vector3())).add(new THREE.Vector3(-0.4, -0.3, 0.9).multiplyScalar(boxScale));
    scene.add(rim);

    const box = prepared.box.clone();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.5);

    const camera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.01, radius * 40);

    // Roofed scenes are shot from inside (a roof would hide the interior),
    // open scenes get a three-quarter aerial view.
    const collision = new CollisionWorld(prepared.meshes);
    const probe = collision.raycast(center.clone().setY(box.min.y + 1.4), new THREE.Vector3(0, 1, 0), 14);
    const interior = Boolean(probe);

    if (interior) {
      // Stand inside the scene at a real walkable spot and look across it,
      // so the thumbnail shows the authored interior rather than a roof.
      const spacing = Math.max(0.35, Math.min(size.x, size.z) / 18);
      const cells = collision.sampleWalkable(box, { spacing, minClearanceLoose: 0.6, wallProbe: 0.45, maxCells: 2500 });
      const floorY = box.min.y;
      const candidates = cells.filter((c) => c.open && c.y < floorY + Math.max(1.2, size.y * 0.55));
      const pool = candidates.length ? candidates : cells;
      const corner = new THREE.Vector3(box.min.x + size.x * 0.2, 0, box.min.z + size.z * 0.2);
      let best = pool[0] || null;
      let bestScore = -Infinity;
      for (const c of pool) {
        const dc = Math.hypot(c.x - corner.x, c.z - corner.z);
        const score = Math.min(c.clearance, 4) * 1.2 - dc * 0.6;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      const eye = best
        ? new THREE.Vector3(best.x, best.y + 1.65, best.z)
        : new THREE.Vector3(box.min.x + size.x * 0.2, box.min.y + Math.min(1.65, size.y * 0.5), box.min.z + size.z * 0.2);
      camera.fov = 78;
      camera.position.copy(eye);
      const look = new THREE.Vector3(
        eye.x + (center.x - eye.x) * 0.9,
        eye.y - Math.max(0.15, size.y * 0.12),
        eye.z + (center.z - eye.z) * 0.9,
      );
      camera.lookAt(look);
      camera.near = Math.max(0.01, radius / 4000);
      camera.far = radius * 60;
      camera.updateProjectionMatrix();
    } else {
      const shotBox = contentBox(prepared.root);
      const shotCenter = shotBox.getCenter(new THREE.Vector3());
      const dir = new THREE.Vector3(0.62, 0.5, 0.66).normalize();
      camera.near = Math.max(0.01, radius / 4000);
      camera.far = radius * 60;
      camera.updateProjectionMatrix();
      frameBox(camera, shotBox, dir, 0.94);
      camera.lookAt(shotCenter);
    }

    const renderer = this._ensureRenderer();
    renderer.render(scene, camera);
    const canvas = renderer.domElement;
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', 0.88));
    if (blob) await cacheSet(key, blob);
    if (blob) map.previewUrl = URL.createObjectURL(blob);
    else map.previewUrl = canvas.toDataURL('image/webp', 0.85);

    scene.remove(prepared.root);
    disposeObject(prepared.root);
    return map.previewUrl;
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
