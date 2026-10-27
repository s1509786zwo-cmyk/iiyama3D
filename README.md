# IIYAMA 3D — ABANDONED RETRIEVAL

A first-person retrieval game built on **four Google Drive GLB maps**. Each map is
loaded from its original `.glb` file, kept independent, and selectable from the
in-game map screen.

| Map ID | File | Scale | Size after scale |
|---|---|---|---|
| `city_street` | `abandoned_city_street_for_games.glb` | 1 | 22.8 × 5.5 × 28.0 m |
| `warehouse` | `abandoned_warehouse_-_interior_scene.glb` | 1 | 36.7 × 7.7 × 36.7 m |
| `subway` | `subway_train_interior.glb` | 0.01 | 4.2 × 3.9 × 12.1 m |
| `classroom` | `abandoned_classroom.glb` | 0.0254 | 5.7 × 2.9 × 11.0 m |

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/ (GLB files are copied as-is)
```

## Verify

```bash
npm run dev
npm run verify   # 100+ automated checks, screenshots in verification/
```

The verification script drives a real headless Chromium (bundled through
`@sparticuz/chromium`, no external download), checks the GLB bytes against the
Google Drive metadata (size + MD5), loads every map, and exercises the full
title → difficulty → map select → game → result flow.

## Structure

```
public/maps/registry.json   data driven map roster (id, file, scale, spawn, gameplay)
public/maps/*.glb           the four original Google Drive assets (unmodified)
public/maps/previews/       thumbnails rendered from the GLB files
public/fonts/               subsetted Noto Sans JP used by the UI
src/core/Loader.js          GLTF loading (+ KHR_materials_pbrSpecularGlossiness), BVH setup
src/core/CollisionWorld.js  floor/ceiling rays, capsule movement, walkable sampling
src/core/Player.js          first person controller (1.8 m body, 1.68 m eyes)
src/core/Enemy.js           patrol/chase drone AI
src/game/GameApp.js         renderer, map lifecycle, run state
src/maps/registry.js        registry loading + GLB availability verification
src/maps/previews.js        thumbnail rendering from the real GLB
src/ui/ui.js                DOM screens and HUD
scripts/verify.mjs          acceptance checks
scripts/render-previews.mjs regenerates the map thumbnails
```

## Adding another map

1. Put the new `.glb` in `public/maps/`.
2. Append an entry to `public/maps/registry.json`:

```json
{
  "id": "new_place",
  "title": "新しい場所",
  "fileName": "new_place.glb",
  "file": "maps/new_place.glb",
  "source": { "provider": "Google Drive", "fileId": "...", "md5": "...", "bytes": 123 },
  "scale": 1,
  "spawn": null,
  "gameplay": { "items": 4, "enemies": 2 },
  "preview": "maps/previews/new_place.webp"
}
```

Nothing is hard-coded to four maps: the map select screen, previews, scaling,
spawn resolution, collision and gameplay all read from the registry. Existing
maps are never modified, and nothing is added automatically — only files listed
in the registry become playable maps.

`spawn: null` means "choose and validate automatically" (walkable floor,
headroom, at least 5 of 8 directions open). A `{ "x": …, "y": …, "z": …, "yaw": … }`
object pins an explicit spawn instead.
