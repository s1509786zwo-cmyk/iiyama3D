/**
 * Unit tests for the character controller against a synthetic room.
 * Run: node tests/controller.test.mjs
 */
import { BufferGeometry, BufferAttribute, Mesh, Group, BoxGeometry, PlaneGeometry, Vector3 } from 'three';
import { buildCollision, CharacterBody } from '../src/core/collision.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

// --- room: 10x10 floor at y=0, wall at x=+2 (2m tall), step box at z=-2 (0.3m tall)
const scene = new Group();

const floor = new Mesh(new PlaneGeometry(60, 60, 1, 1));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const wall = new Mesh(new BoxGeometry(0.2, 2.4, 10));
wall.position.set(2, 1.2, 0);
scene.add(wall);

const step = new Mesh(new BoxGeometry(2, 0.3, 2));
step.position.set(0, 0.15, -2);
scene.add(step);

scene.updateMatrixWorld(true);
const { bvh } = buildCollision(scene);
console.log('controller tests');
check('BVH built from merged scene', !!bvh);

const body = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
body.teleport(0, 1.0, 0);
for (let i = 0; i < 60; i++) body.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
check('falls to the floor and stays grounded', body.grounded && Math.abs(body.position.y) < 0.05, `y=${body.position.y.toFixed(3)}`);

// walk into the wall
const startX = body.position.x;
for (let i = 0; i < 180; i++) body.update(1 / 60, new Vector3(1, 0, 0), { speed: 3.1 });
check('stops before the wall (no penetration)', body.position.x < 2 - 0.2, `x=${body.position.x.toFixed(3)}`);
check('actually moved toward the wall', body.position.x > startX + 0.8, `x=${body.position.x.toFixed(3)}`);
check('still grounded after collision', body.grounded && Math.abs(body.position.y) < 0.06, `y=${body.position.y.toFixed(3)}`);

// walk onto a 0.3m step (step-up)
const stepper = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
stepper.teleport(0, 0.05, 0);
for (let i = 0; i < 30; i++) stepper.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
for (let i = 0; i < 55; i++) stepper.update(1 / 60, new Vector3(0, 0, -1), { speed: 3.1 });
check('climbs a 0.30 m step', stepper.position.y > 0.25, `y=${stepper.position.y.toFixed(3)} z=${stepper.position.z.toFixed(2)}`);

// line of sight
check('line of sight blocked by wall', body.lineOfSight(new Vector3(0, 1.5, 0), new Vector3(4, 1.5, 0)) === false);
check('line of sight clear in open air', body.lineOfSight(new Vector3(0, 1.5, 0), new Vector3(0, 1.5, 1.5)) === true);

// no falling through the floor at high speed
const faller = new CharacterBody({ bvh, radius: 0.24, height: 1.75 });
faller.teleport(0, 6, 0);
for (let i = 0; i < 200; i++) faller.update(1 / 60, new Vector3(0, 0, 0), { speed: 0 });
check('does not fall through the floor from 6 m', faller.position.y > -0.1 && faller.position.y < 0.2, `y=${faller.position.y.toFixed(3)}`);

console.log(failures === 0 ? '\nALL CONTROLLER TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
