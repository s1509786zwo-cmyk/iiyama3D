/**
 * Map registry.
 *
 * Every entry is an independent map: its own file reference, calibration,
 * collision data, spawn point and spawn direction. Nothing here caps the list
 * at four entries — appending a new object adds a new selectable map.
 *
 * The `scale` values are NOT a shared multiplier: each one is derived from the
 * unit system of the original export and checked against real-world references
 * in the model (ceiling / door / floor heights).  See MAP_CALIBRATION below.
 */
import baked from './baked.json';

/**
 * How each scale was calibrated (measured with tools/measure.mjs + tools/floor-planes.mjs):
 *  - city_street : authored in metres already.  Floor plane at y=-0.05, doorway
 *                  lintels ~1.95 m, building tops 2.6–5.5 m  -> 1.0 unit = 1 m.
 *  - warehouse   : authored in metres.  Floor y=-2.95, ceiling y=+3.35
 *                  (= 6.3 m clear height, correct for an industrial hall)  -> 1.0.
 *  - subway      : authored in centimetres.  Floor y=4 -> ceiling y=291
 *                  = 287 cm = 2.87 m interior height (realistic car interior) -> 0.01.
 *  - classroom   : SketchUp export in inches.  Floor y=0.3 -> ceiling y=113.7
 *                  = 113.4 in = 2.88 m (desk tops land at ~30 in = 0.76 m) -> 0.0254.
 */
export const MAP_CALIBRATION = {
  city_street: { unit: 1.0, unitName: 'metre', reference: '扉上部 1.95 / 建物 2.6–5.5 (m相当)' },
  warehouse: { unit: 1.0, unitName: 'metre', reference: '床 -2.95 → 天井 +3.35 (6.3m)' },
  subway: { unit: 0.01, unitName: 'centimetre', reference: '床 4 → 天井 291 (287cm=2.87m)' },
  classroom: { unit: 0.0254, unitName: 'inch', reference: '床 0.3 → 天井 113.7 (113.4in=2.88m)' },
};

/** @typedef {{id:string,name:string,description:string,file:string,sourceFile:string,
 *            driveFileId:string,scale:number,ambient:number,color:string,fog:[number,number],
 *            difficultyNotes:string}} MapDef */

/** The four maps requested by the user (Google Drive file names are kept verbatim). */
const MAP_DEFS = [
  {
    id: 'city_street',
    name: '廃都ストリート',
    short: '市街',
    description: '開発が放棄された街区。瓦礫の積もる路地と、倒壊寸前の建物群。',
    file: 'maps/city_street.glb',
    sourceFile: 'abandoned_city_street_for_games.glb',
    driveFileId: '1drWth7I5l0rY92ko9H3foP99RTBdixx5',
    fog: [16, 46],
    fogColor: '#10161a',
    ambient: 0.55,
    sunColor: '#cfd9e0',
    sunIntensity: 1.9,
    thumbHint: [1, 0.55, 1],
  },
  {
    id: 'warehouse',
    name: '廃倉庫 ─ 内部',
    short: '倉庫',
    description: '荷物が打ち捨てられた巨大な倉庫。天井が高く、物陰が多い。',
    file: 'maps/warehouse.glb',
    sourceFile: 'abandoned_warehouse_-_interior_scene.glb',
    driveFileId: '1rr0bIx6odYH71UY9RFYWKdDm-yuEjDKG',
    fog: [8, 40],
    fogColor: '#0d1114',
    ambient: 0.4,
    sunColor: '#b9c7d0',
    sunIntensity: 1.35,
    thumbHint: [0.9, 0.6, 1],
  },
  {
    id: 'subway',
    name: '地下鉄車内',
    short: '地下鉄',
    description: '停電した地下鉄の車両。狭い通路と座席、閉じた扉。',
    file: 'maps/subway.glb',
    sourceFile: 'subway_train_interior.glb',
    driveFileId: '1zNx4GjSx6FdZujBkpmA7IHy6s-ta_R5v',
    fog: [6, 26],
    fogColor: '#080c0f',
    ambient: 0.42,
    sunColor: '#a9bcc8',
    sunIntensity: 0.9,
    thumbHint: [1, 0.4, 0.85],
  },
  {
    id: 'classroom',
    name: '廃校の教室',
    short: '教室',
    description: '机と椅子が並んだまま放置された教室。窓から差す光だけが頼り。',
    file: 'maps/classroom.glb',
    sourceFile: 'abandoned_classroom.glb',
    driveFileId: '1-1SgZ-zl7outgFUm7MaX21aIR8T3l6ej',
    fog: [10, 34],
    fogColor: '#0e1215',
    ambient: 0.62,
    sunColor: '#e8dfc8',
    sunIntensity: 1.6,
    thumbHint: [1, 0.5, 0.9],
  },
];

export const MAPS = MAP_DEFS.map((def, index) => {
  const data = baked[def.id];
  if (!data) throw new Error(`baked map data missing for ${def.id}`);
  return {
    ...def,
    index,
    scale: data.scale,
    baseY: data.baseY,
    bbox: data.bbox,
    spawn: data.spawn,
    objectives: data.objectives,
    patrols: data.patrols,
    grid: data.grid,
    calibration: MAP_CALIBRATION[def.id],
    sizeLabel: `${(data.bbox.max[0] - data.bbox.min[0]).toFixed(1)} × ${(data.bbox.max[2] - data.bbox.min[2]).toFixed(1)} m`,
  };
});

export const getMap = (id) => MAPS.find((m) => m.id === id) || null;

export const DIFFICULTIES = [
  {
    id: 'calm',
    name: '静穏',
    tag: 'EASY',
    description: '敵は少なく、足も遅い。マップの構造を確かめるならここから。',
    enemyCount: 1,
    enemySpeed: 1.45,
    detectRange: 9,
    damage: 12,
    health: 120,
    stamina: 1.15,
  },
  {
    id: 'normal',
    name: '標準',
    tag: 'NORMAL',
    description: '標準的な脅威。音と気配に注意して、記録を回収し脱出せよ。',
    enemyCount: 2,
    enemySpeed: 1.9,
    detectRange: 13,
    damage: 18,
    health: 100,
    stamina: 1.0,
  },
  {
    id: 'severe',
    name: '苛烈',
    tag: 'HARD',
    description: '敵が増え、視界も広い。見つかれば追跡から逃げ切るのは難しい。',
    enemyCount: 3,
    enemySpeed: 2.35,
    detectRange: 17,
    damage: 26,
    health: 85,
    stamina: 0.85,
  },
];

export const getDifficulty = (id) => DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[1];
