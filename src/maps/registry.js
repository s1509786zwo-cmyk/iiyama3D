/**
 * Map registry.
 *
 * The roster is data driven (public/maps/registry.json). Nothing here is
 * hard-coded to four maps: appending an entry adds a new selectable map and
 * leaves the existing ones untouched.
 */

const REGISTRY_URL = 'maps/registry.json';

export class MapRegistry {
  constructor() {
    this.maps = [];
    this.error = null;
  }

  async load() {
    try {
      const res = await fetch(`${REGISTRY_URL}?t=${Date.now()}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json.maps) ? json.maps : [];
      this.maps = list.map((m, i) => this._normalize(m, i));
      return this.maps;
    } catch (err) {
      this.error = err;
      this.maps = [];
      return this.maps;
    }
  }

  _normalize(m, index) {
    const fileName = m.fileName || (m.file ? m.file.split('/').pop() : `map_${index}.glb`);
    return {
      id: m.id || `map_${index}`,
      order: index,
      title: m.title || fileName,
      subtitle: m.subtitle || '',
      fileName,
      file: m.file || `maps/${fileName}`,
      source: m.source || {},
      scale: Number.isFinite(m.scale) ? m.scale : 1,
      spawn: m.spawn || null,
      collision: { stepHeight: 0.38, eyeHeight: 1.68, ...(m.collision || {}) },
      gameplay: { items: 4, enemies: 2, ...(m.gameplay || {}) },
      preview: m.preview || null,
      // runtime state
      status: 'idle',
      error: null,
      headBytes: null,
      previewUrl: null,
    };
  }

  /**
   * Confirms the GLB is really present and complete (not just listed).
   * Uses a ranged request so we compare the actual byte length with the
   * registry record.
   */
  async probeAvailability(map) {
    try {
      const res = await fetch(map.file, { method: 'GET', headers: { Range: 'bytes=0-15' } });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const magic = new TextDecoder().decode(buf.slice(0, 4));
      const cr = res.headers.get('content-range');
      let total = null;
      if (cr) {
        const m = cr.match(/\/(\d+)$/);
        if (m) total = Number(m[1]);
      }
      if (!total) {
        const len = res.headers.get('content-length');
        if (len) total = Number(len);
      }
      map.headBytes = total;
      if (magic !== 'glTF') {
        map.status = 'error';
        map.error = 'GLB ヘッダが不正です (glTF マジックが見つかりません)';
        return false;
      }
      if (map.source?.bytes && total && Math.abs(total - map.source.bytes) > 1024) {
        map.status = 'error';
        map.error = `ファイルサイズ不一致 (期待 ${map.source.bytes} / 実際 ${total})`;
        return false;
      }
      map.status = 'ready';
      return true;
    } catch (err) {
      map.status = 'error';
      map.error = `取得に失敗: ${err.message}`;
      return false;
    }
  }
}
