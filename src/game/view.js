/**
 * The single source of truth for the viewer.
 *
 * Every map uses exactly these values — there is no per-map override, which is
 * what keeps the eye line identical everywhere.
 *
 * Measured environment references that these numbers were checked against
 * (tools/anthropometrics.mjs / tools/furniture-audit.mjs, at each map's
 * calibrated scale):
 *
 *   map          floor→ceiling   desk/seat    door/opening   ceiling ÷ eye
 *   classroom       2.87 m       0.72 / 0.45      ~2.0 m         1.77
 *   subway          2.85 m         0.45 seat      2.49 m         1.76
 *   warehouse       6.35 m         0.50 crate     2.71–3.31 m    3.92  (industrial hall)
 *   city_street     open sky      0.45 ledge     2.55 m         —
 *
 * The two closed interiors agree on ceiling ÷ eye height to within 1 %, so the
 * same 1.62 m eye line is correct in every map.
 */

/** total standing height of the player, metres */
export const PLAYER_HEIGHT = 1.75;

/** camera height above the floor the player is actually standing on, metres */
export const EYE_HEIGHT = 1.62;

/** capsule radius, metres (shoulder half-width) */
export const PLAYER_RADIUS = 0.24;

/**
 * Vertical field of view, degrees.
 *
 * This used to be 74°, which is ≈110° horizontal on a 16:9 screen — a fisheye
 * that makes walls and furniture read as small and distant (the "giant's eye
 * view" complaint). 64° vertical ≈ 99° horizontal is the normal human-ish
 * game field of view and keeps objects at their true apparent size.
 */
export const FOV = 64;

/** walking / sprinting speed, metres per second */
export const WALK_SPEED = 3.15;
export const SPRINT_SPEED = 5.5;

/** how far below the eye the floor snap searches (seconds of fall) */
export const EYE_PROBE_UP = 0.06;

/**
 * Camera Y for a player whose feet are at `floorY`.
 * Always floor + EYE_HEIGHT — identical in every map.
 */
export const cameraYFor = (floorY) => floorY + EYE_HEIGHT;
