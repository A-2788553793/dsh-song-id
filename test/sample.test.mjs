import assert from 'node:assert/strict';
import test from 'node:test';

import { samplePoints } from '../src/pipeline/media.js';

test('默认三段铺在 12% / 42% / 72%', () => {
  const points = samplePoints({ duration: 1000, clips: 3, clipSeconds: 12 });
  assert.deepEqual(points, [120, 420, 720]);
});

test('单段落在 40% 处', () => {
  const points = samplePoints({ duration: 1000, clips: 1, clipSeconds: 12 });
  assert.deepEqual(points, [400]);
});

test('给了 at 就从 at 起连续取', () => {
  const points = samplePoints({ duration: 600, at: 60, clips: 3, clipSeconds: 12 });
  assert.deepEqual(points, [60, 72, 84]);
});

test('at 太靠后会被时长截断', () => {
  const points = samplePoints({ duration: 100, at: 95, clips: 3, clipSeconds: 12 });
  assert.deepEqual(points, [95]);
});

test('采样点不会越界（留出片段长度）', () => {
  const points = samplePoints({ duration: 100, clips: 5, clipSeconds: 20 });
  for (const p of points) assert.ok(p >= 0 && p <= 100 - 20, `point ${p} in range`);
});

test('时长未知时退回 0', () => {
  assert.deepEqual(samplePoints({ duration: 0, clips: 3, clipSeconds: 12 }), [0]);
});

test('clips 越界会被夹到 1..5', () => {
  assert.equal(samplePoints({ duration: 1000, clips: 99, clipSeconds: 12 }).length, 5);
  assert.equal(samplePoints({ duration: 1000, clips: 0, clipSeconds: 12 }).length, 1);
});
