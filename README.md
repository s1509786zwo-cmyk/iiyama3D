# IIYAMA 3D — ABANDONED

Google Drive に保存されている 4 つの GLB シーンを**実際に取得して**そのままマップとして
読み込み、一人称視点で探索できる 3D ゲームです。マップはタイトル画面 → マップ選択画面で
個別に選択でき、選択したモデルがゲーム内にそのまま表示されます。

```
npm install          # three / three-mesh-bvh / ツール用の依存（初回のみ）
npm start            # http://localhost:5173
npm test             # 配線チェック + 実アセットでの統合テスト（97 checks）
```

---

## 1. 読み込んでいるマップ

| マップID | ファイル名（Google Drive） | Drive fileId | 元サイズ | 収録サイズ | 三角形数 | 単位換算 |
|---|---|---|---|---|---|---|
| `city_street` | `abandoned_city_street_for_games.glb` | `1AEOP_u8YO1BkPqi9XWEvDSHaLCsw67fv` | 37.95 MB | 31.28 MB | 15,767 | 1 unit = 1 m（倍率 1.0） |
| `warehouse` | `abandoned_warehouse_-_interior_scene.glb` | `1rr0bIx6odYH71UY9RFYWKdDm-yuEjDKG` | 68.01 MB | 18.86 MB | 993,366 | 1 unit = 1 m（倍率 1.0） |
| `subway` | `subway_train_interior.glb` | `1J6cKolQ1BQngdkVajrjC2gMkf1ZfSvOo` | 98.74 MB | 41.51 MB | 1,302,796 | 0.01 m/unit（倍率 0.0127） |
| `classroom` | `abandoned_classroom.glb` | `1OQCqq5p9z-Wa3ZOhq-YK7IpNJAT8PlYI` | 7.62 MB | 3.01 MB | 59,660 | インチ（倍率 0.0254） |

* 取得は Google Drive 連携で行い、全ファイルで **Drive の MD5 と一致**することを確認済み
  （`docs/provenance.json`）。
* 元のメッシュ形状・UV・法線・ノード変換・マテリアル・テクスチャ解像度は保持しています
  （`docs/asset-report.json` / `npm run verify:assets`）。
* 単位系は 4 つとも異なるため、**マップごとに倍率を個別に決定**しています
  （天井高・机・シート・ドアなどの実寸から検証。詳細は `docs/VERIFICATION.md`）。

## 2. ゲームの流れ

```
起動（4マップを先読み） → タイトル → マップ選択 → 難易度選択 → ゲーム
                                        ↑                        ↓
                                    リトライ ← ← ポーズ／リザルト（生還・ゲームオーバー）
```

* **マップ選択画面**: 各マップについて「実際の 3D モデルから描画したプレビュー画像」
  「ファイル名」「選択ボタン」「選択状態」「読み込み状態（未読み込み／読み込み中／
  読み込み済み／失敗）」を表示します。
* 4 つすべてが読み込めた場合のみ全カードが選択可能になります。読み込みに失敗した
  マップは選択できず、その旨をカードとヒント欄に表示します。
* 選択したマップ ID は `state.selectedMapId` に保持され、ゲーム開始時は必ずそのマップを
  使います。**別マップでの代用は行わず**、読み込めていない場合は開始せずエラー表示します。
* 難易度（EASY / NORMAL / HARD）で敵の数・速度・視界・ダメージが変わります。
* セーブ（`localStorage`）に前回のマップ・難易度・生存記録を保存し、タイトルの
  「つづきから」で復帰できます。

## 3. 操作

| 操作 | キー |
|---|---|
| 移動 | `W` `A` `S` `D` / 矢印 |
| 視点 | マウス（ポインタロック。キャンバスをクリックでロック） |
| 走る | `Shift` |
| ジャンプ | `Space` |
| ポーズ | `Esc` |

プレイヤーは全マップ共通で **身長 1.75 m / 目線 1.65 m / 半径 0.32 m / 段差 0.35 m**。

## 4. ディレクトリ構成

```
index.html            画面（タイトル／マップ選択／難易度／HUD／ポーズ／リザルト）
styles.css
server.mjs            依存なしの静的サーバ（0.0.0.0 バインド、Host 制限なし）
src/
  main.js             エントリ（ブラウザ実装をフローに接続）
  game/maps.js        manifest を読むマップレジストリ（4 件固定ではない）
  game/mapLibrary.js  GLB/コリジョン/nav の読み込みと状態管理
  game/flow.js        画面遷移・ゲーム進行（DOM/描画非依存 → Node で検証可能）
  game/physics.js     カプセル＋BVH の一人称キャラクタ制御（段差・壁滑り）
  game/nav.js         nav グリッド（到達判定・床高・A*）
  game/enemy.js       敵 AI（同じ nav グリッドで経路探索）・難易度定義
  game/world.js       three.js シーン／カメラ／ライト
  game/input.js       キーボード＋ポインタロック
  game/save.js        セーブ
  ui/screens.js       各画面の描画
assets/maps/
  manifest.json       マップ定義（唯一の情報源）
  models/*.glb        ゲーム用 GLB（Google Drive 由来・ロスレス変換）
  collision/*.glb     衝突判定メッシュ（ゲーム座標系でベイク済み）
  nav/*.nav.json      nav グリッド＋床高＋スポーン
  nav/*.meta.json     ベイク情報（倍率・オフセット・開始方向など）
  previews/*.webp     実モデルからレンダリングしたプレビュー
vendor/               three.js / three-mesh-bvh / Draco デコーダ（オフライン動作）
tools/                取得後処理・ベイク・検証スクリプト（下記）
docs/                 検証レポート・来歴情報
```

## 5. アセットの作り方（元モデルを崩さないための手順）

```bash
# 1) Google Drive から取得した GLB を google_drive/ に置く（Drive 連携で取得）
# 2) テクスチャをロスレス WebP 化、インデックスを 16bit 化、spec/gloss を PBR へ等価変換
python3 tools/build_assets.py /tmp/assets
# 3) ジオメトリを Draco 圧縮（位置/法線/UV を 16bit 量子化）
node tools/draco.mjs /tmp/assets assets/maps/models
# 4) 衝突判定 + nav グリッド + 開始地点を焼き込み
bash tools/bake_all.sh
# 5) manifest とプレビューを生成
python3 tools/make_manifest.py
# 6) 検証
npm test && npm run verify:assets
```

* テクスチャは WebP ロスレス化しても**画素値・解像度は完全一致**（検証済み）。
* Draco は位置を 16bit 量子化するため、最大 5 mm 程度の誤差が出ます（30 m 級のシーンに
  対して画面 1 画素未満）。テクスチャ・マテリアル・UV の値そのものは変化しません。
* 収録サイズを 208 MB → 98 MB に抑えているのは、この 2 点（ロスレス WebP + Draco）に
  よるものです。**解像度の縮小・ロッシー圧縮・ポリゴン削減は行っていません**。

## 6. マップを増やすには（4 つに固定しない設計）

1. 新しい GLB を Drive から取得し `google_drive/` に置く（**自動採用はしません**）。
2. `tools/bake_all.sh` の表に 1 行追加（GLB 名 / マップID / 倍率）。
3. `tools/make_manifest.py` の `MAPS` に 1 行追加（ID / 表示名 / ファイル名 / Drive ID）。
4. `python3 tools/make_manifest.py && npm test`。

`manifest.json` に追記されるだけで、既存マップの定義は変更されません。マップ ID・
ファイル参照・衝突判定・開始地点・倍率はマップごとに独立して管理しています。

## 7. 検証

```
npm run test:wiring   # HTML/JS/manifest の配線、ID・import・アセットパス・プレイヤー寸法
npm run test:game     # 実アセットでの統合テスト 97 項目（読み込み・物理・敵AI・画面遷移）
npm run verify:assets # Drive 原本との画素数・解像度・三角形数の一致確認
node tools/verify_draco.mjs ...   # Draco 前後の構造一致
```

結果の詳細と、**この環境で確認できなかった項目**は `docs/VERIFICATION.md` を参照して
ください（サンドボックスにブラウザが無いため、GPU 描画だけは未確認です）。
