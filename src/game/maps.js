// Map registry.
//
// Maps are NOT hard-coded to four entries: everything that describes a playable map
// (model file, collision file, nav grid, preview, unit scale, rotation, world offset,
// spawn point, spawn heading) lives in /assets/maps/manifest.json, which is produced by
// tools/bake.py + tools/make_manifest.py.
//
// To add a new GLB map later:
//   1. drop the .glb into google_drive/ (or straight into assets/maps/)
//   2. python3 tools/bake.py <glb> --label <id> --scale <units-per-metre>
//   3. python3 tools/make_manifest.py        (adds/updates the entry, keeps the others)
//   4. npm run preview                       (no code change required)
//
// Nothing is auto-discovered: only maps listed in the manifest are ever used.

export const MANIFEST_URL = '/assets/maps/manifest.json';

export class MapRegistry {
  constructor() {
    /** @type {MapDefinition[]} */
    this.maps = [];
    this.byId = new Map();
    this.source = null;
  }

  async load() {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`マップ定義を読み込めません (${res.status})`);
    const json = await res.json();
    this.source = json;
    this.maps = (json.maps || []).map((m) => ({
      id: m.id,
      label: m.label || m.id,
      sourceFile: m.sourceFile,
      model: m.model,
      collision: m.collision,
      nav: m.nav,
      preview: m.preview || null,
      // unit conversion + world placement, baked per map (never a global constant)
      scale: m.scale ?? 1,
      rotationDeg: m.rotationDeg || [0, 0, 0],
      offset: m.offset || [0, 0, 0],
      spawn: m.spawn || { position: [0, 0, 0], yawDeg: 0 },
      bounds: m.bounds || null,
      stats: m.stats || {},
      notes: m.notes || [],
      // player size is unified across maps
      player: m.player || { height: 1.75, eyeHeight: 1.65, radius: 0.32, step: 0.35 },
    }));
    this.byId = new Map(this.maps.map((m) => [m.id, m]));
    return this.maps;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Append a definition at runtime (kept for future in-game map addition). */
  register(def) {
    if (this.byId.has(def.id)) return this.byId.get(def.id);
    this.maps.push(def);
    this.byId.set(def.id, def);
    return def;
  }
}
