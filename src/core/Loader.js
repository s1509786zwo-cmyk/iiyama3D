import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Fast raycasting against the original (unmodified) map geometry.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * KHR_materials_pbrSpecularGlossiness support.
 *
 * three.js r169 no longer ships this extension, and the warehouse scene is
 * authored entirely with it. Without it every surface would render untextured
 * white. The plugin maps the original diffuse texture/factor onto the standard
 * material and converts the glossiness factor into roughness, which keeps the
 * authored colours and textures intact (no re-authoring of the model).
 */
class GLTFMaterialsPbrSpecularGlossinessExtension {
  constructor(parser) {
    this.parser = parser;
    this.name = 'KHR_materials_pbrSpecularGlossiness';
  }

  getMaterialType(materialIndex) {
    const materialDef = this.parser.json.materials[materialIndex];
    if (!materialDef.extensions || !materialDef.extensions[this.name]) return null;
    return THREE.MeshStandardMaterial;
  }

  extendMaterialParams(materialIndex, materialParams) {
    const parser = this.parser;
    const materialDef = parser.json.materials[materialIndex];
    if (!materialDef.extensions || !materialDef.extensions[this.name]) return Promise.resolve();

    const ext = materialDef.extensions[this.name];
    const pending = [];

    const df = ext.diffuseFactor || [1, 1, 1, 1];
    materialParams.color = new THREE.Color().setRGB(df[0], df[1], df[2], THREE.LinearSRGBColorSpace);
    materialParams.opacity = df[3];
    if (ext.diffuseTexture !== undefined) {
      pending.push(parser.assignTexture(materialParams, 'map', ext.diffuseTexture, THREE.SRGBColorSpace));
    }

    // Specular-glossiness -> metallic-roughness approximation that preserves
    // the diffuse look: metals stay 0, glossiness drives roughness.
    materialParams.metalness = 0;
    const gloss = ext.glossinessFactor !== undefined ? ext.glossinessFactor : 1;
    materialParams.roughness = THREE.MathUtils.clamp(1 - gloss, 0.04, 1);
    if (ext.specularFactor !== undefined && ext.specularFactor[0] > 0.6) {
      materialParams.metalness = 0.05;
    }
    return Promise.all(pending);
  }
}

export class MapAssetLoader {
  constructor() {
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new GLTFMaterialsPbrSpecularGlossinessExtension(parser));
  }

  /**
   * @param {string} url GLB url
   * @param {(ratio:number)=>void} onProgress
   * @returns {Promise<{scene: THREE.Group, stats: object}>}
   */
  async loadGLB(url, onProgress) {
    const manager = new THREE.LoadingManager();
    this.loader.manager = manager;
    manager.onProgress = (_url, loaded, total) => {
      if (onProgress && total > 0) onProgress(Math.min(1, loaded / total));
    };

    manager.onLoad = () => {};
    const gltf = await new Promise((resolve, reject) => {
      this.loader.load(
        url,
        resolve,
        (evt) => {
          if (onProgress && evt.total) onProgress(Math.min(1, evt.loaded / evt.total));
        },
        reject,
      );
    });

    this.loader.manager = new THREE.LoadingManager();
    return gltf;
  }
}

export const RENDER_DEFAULTS = {
  maxAnisotropy: 8,
};

/**
 * Prepares a loaded glTF scene for rendering + collision while leaving the
 * authored geometry, UVs, textures and materials untouched.
 */
export function prepareMapScene(gltf, { scale = 1, renderer, anisotropy = 8 } = {}) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const textures = new Set();
  let triangles = 0;
  let vertices = 0;
  const materials = new Set();
  const meshes = [];

  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    meshes.push(obj);
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.frustumCulled = true;
    const geo = obj.geometry;
    if (geo) {
      const count = geo.index ? geo.index.count : geo.attributes.position?.count || 0;
      triangles += Math.floor(count / 3);
      vertices += geo.attributes.position?.count || 0;
      if (geo.attributes.position && !geo.boundsTree) geo.computeBoundsTree();
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'specularMap']) {
        const tex = mat[key];
        if (tex) {
          textures.add(tex);
          if (tex.anisotropy !== undefined) {
            const max = renderer ? renderer.capabilities.getMaxAnisotropy() : anisotropy;
            tex.anisotropy = Math.min(anisotropy, max);
          }
          tex.needsUpdate = true;
        }
      }
      // Keep the authored look but make it work with the game's lighting.
      if ('envMapIntensity' in mat) mat.envMapIntensity = 0.55;
      if (mat.metalness !== undefined && mat.metalness > 0.85 && !mat.metalnessMap) mat.metalness = 0.85;
      mat.shadowSide = THREE.FrontSide;
    }
    obj.updateMatrixWorld(true);
  });

  if (scale && scale !== 1) {
    root.scale.multiplyScalar(scale);
    root.updateMatrixWorld(true);
  }

  const box = new THREE.Box3().setFromObject(root);

  return {
    root,
    meshes,
    box,
    stats: {
      triangles,
      vertices,
      materials: materials.size,
      textures: textures.size,
      meshes: meshes.length,
      size: box.getSize(new THREE.Vector3()),
      center: box.getCenter(new THREE.Vector3()),
      scale,
    },
  };
}

export function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.geometry?.disposeBoundsTree?.();
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose?.();
      }
    }
  });
}
