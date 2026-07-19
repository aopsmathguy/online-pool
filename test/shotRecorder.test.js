// test/shotRecorder.test.js — the delta encoder, with literal poses.
//
// Ammo-free by design (like ai.test.js): the recorder takes plain pose objects,
// so the encoding rules can be tested exactly rather than inferred from a
// physics run. shotRecording.test.js covers the same encoder end-to-end through
// a real shot; this file covers the cases a real shot won't reliably produce —
// drift that accumulates past the threshold, rotation changing while position
// does not, and the baseline reset between shots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShotRecorder, REPLAY_FRAME_DT } from '../src/server/shotRecorder.js';

const IDENTITY = { qx: 0, qy: 0, qz: 0, qw: 1 };
const ball = (id, x = 0, y = 0, z = 0, q = IDENTITY) => ({ id, x, y, z, ...q });

test('recorder: the first capture is full regardless of the delta flag', () => {
  const rec = createShotRecorder();
  rec.capture([ball(0), ball(1, 1)]);
  assert.equal(rec.frames[0].pos.length, 2);
  assert.equal(rec.frames[0].rot.length, 2);
});

test('recorder: an unchanged ball is omitted from delta frames', () => {
  const rec = createShotRecorder();
  const balls = [ball(0), ball(1, 1)];
  rec.capture(balls);
  rec.capture(balls, { delta: true });
  assert.deepEqual(rec.frames[1].pos, []);
  assert.deepEqual(rec.frames[1].rot, []);
});

test('recorder: a moved ball reappears, its neighbours do not', () => {
  const rec = createShotRecorder();
  rec.capture([ball(0), ball(1, 1)]);
  rec.capture([ball(0, 0.5), ball(1, 1)], { delta: true });
  assert.equal(rec.frames[1].pos.length, 1);
  assert.equal(rec.frames[1].pos[0].id, 0);
  assert.deepEqual(rec.frames[1].rot, [], 'rotation did not change, so nothing to send');
});

test('recorder: rotation is tracked independently of position', () => {
  const rec = createShotRecorder();
  rec.capture([ball(0)]);
  // Spinning in place: same position, new orientation.
  rec.capture([ball(0, 0, 0, 0, { qx: 0.5, qy: 0, qz: 0, qw: 0.866 })], { delta: true });
  assert.deepEqual(rec.frames[1].pos, [], 'position unchanged — must not be resent');
  assert.equal(rec.frames[1].rot.length, 1, 'rotation changed — must be resent');
});

test('recorder: sub-threshold movement is dropped', () => {
  const rec = createShotRecorder();
  rec.capture([ball(0)]);
  rec.capture([ball(0, 1e-5)], { delta: true });   // well under POS_EPS (1e-4)
  assert.deepEqual(rec.frames[1].pos, []);
});

test('recorder: slow drift accumulates into an eventual resend', () => {
  // THE reason baselines hold the last TRANSMITTED value rather than the last
  // captured one. Ten steps of 3e-5 each are individually below POS_EPS; if the
  // baseline advanced every frame the ball would drift forever in silence.
  const rec = createShotRecorder();
  rec.capture([ball(0)]);
  let x = 0, resends = 0;
  for (let i = 0; i < 10; i++) {
    x += 3e-5;
    rec.capture([ball(0, x)], { delta: true });
    if (rec.frames[rec.frames.length - 1].pos.length) resends++;
  }
  assert.ok(resends >= 1, 'accumulated drift of 3e-4 must eventually be transmitted');
});

test('recorder: a non-delta capture resets the baselines', () => {
  const rec = createShotRecorder();
  rec.capture([ball(0), ball(1, 1)]);
  rec.capture([ball(0), ball(1, 1)], { delta: true });
  assert.deepEqual(rec.frames[1].pos, []);
  rec.capture([ball(0), ball(1, 1)]);              // full again
  assert.equal(rec.frames[2].pos.length, 2, 'everything must be recaptured');
});

test('recorder: capture returns the index of the frame it wrote', () => {
  const rec = createShotRecorder();
  assert.equal(rec.capture([ball(0)]), 0);
  assert.equal(rec.capture([ball(0)], { delta: true }), 1);
  assert.equal(rec.frameCount, 2);
});

test('recorder: duration counts intervals, not frames', () => {
  const rec = createShotRecorder();
  assert.equal(rec.durationMs, 0, 'no frames yet');
  rec.capture([ball(0)]);
  assert.equal(rec.durationMs, 0, 'one frame spans no time');
  rec.capture([ball(0, 1)], { delta: true });
  assert.equal(rec.durationMs, REPLAY_FRAME_DT * 1000, 'two frames span one interval');
});

test('recorder: a ball appearing mid-recording is captured in full', () => {
  // Balls enter the pose stream when they are sunk into a cup; the encoder must
  // not assume a stable ball set.
  const rec = createShotRecorder();
  rec.capture([ball(0)]);
  rec.capture([ball(0), ball(7, 2, 0, 1)], { delta: true });
  const added = rec.frames[1].pos.find(p => p.id === 7);
  assert.ok(added, 'the new ball must appear in the frame');
  assert.equal(rec.frames[1].rot.filter(r => r.id === 7).length, 1, 'with its rotation too');
});
