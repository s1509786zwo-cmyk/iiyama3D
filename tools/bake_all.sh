#!/usr/bin/env bash
# Re-bake nav grids, collision meshes and spawn points for every map.
# Run this after changing tools/bake.py, or when adding a map.
set -euo pipefail
cd "$(dirname "$0")/.."

# label   source GLB                                    units per metre
while read -r glb label scale; do
  echo "== $label"
  python3 tools/bake.py "google_drive/$glb" \
    --label "$label" --scale "$scale" --rot=0,0,0 \
    --out assets/maps/_bake
done <<'MAPS'
abandoned_city_street_for_games.glb   city      1.0
abandoned_warehouse_-_interior_scene.glb warehouse 1.0
subway_train_interior.glb             subway    0.0127
abandoned_classroom.glb               classroom 0.0254
MAPS

mkdir -p assets/maps/collision assets/maps/nav
for m in city warehouse subway classroom; do
  cp "assets/maps/_bake/$m.collision.glb" assets/maps/collision/
  cp "assets/maps/_bake/$m.nav.json" assets/maps/nav/
  cp "assets/maps/_bake/$m.bake.json" "assets/maps/nav/$m.meta.json"
  cp "assets/maps/_bake/${m}_nav.png" assets/maps/nav/ 2>/dev/null || true
done
rm -rf assets/maps/_bake
python3 tools/make_manifest.py
