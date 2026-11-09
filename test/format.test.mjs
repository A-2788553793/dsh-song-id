import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clock, formatResult } from '../src/format.js';
import { get, put } from '../src/pipeline/cache.js';

test('clock 格式化', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(70), '1:10');
  assert.equal(clock(3671), '1:01:11');
  assert.equal(clock(undefined), '?');
});

test('命中时第一行就是歌名 — 歌手', () => {
  const text = formatResult({
    ok: true,
    song: { title: 'Song Title', artist: 'Artist Name', album: 'Album Name', genre: 'Pop', cover: 'https://img/x.jpg' },
    video: { title: '示例投稿', duration: 300, id: 'BVxxxxxxxxxx', url: 'https://www.bilibili.com/video/BVxxxxxxxxxx' },
    playedAt: 70,
    points: [30, 70, 120],
    clipSeconds: 12,
    tried: [{ at: 30, ok: false }, { at: 70, ok: true }],
  });
  const first = text.split('\n')[0];
  assert.equal(first, '🎵 **Song Title** — Artist Name');
  assert.match(text, /专辑：Album Name/);
  assert.match(text, /命中位置：1:10/);
  assert.match(text, /12 秒片段/);
});

test('变调命中时明确提醒结论可能不准，并列出一路扫到的其他歌', () => {
  const text = formatResult({
    ok: true,
    song: { title: 'Song A (DJ版)', artist: 'Artist A' },
    video: { title: '降调版投稿', duration: 256 },
    playedAt: 55,
    clipSeconds: 12,
    shift: 1.06,
    matches: [
      { title: 'Song A (DJ版)', artist: 'Artist A', at: 55, shift: 1.06 },
      { title: 'Song B', artist: 'Artist B', at: 75, shift: 1.12 },
    ],
    tried: [{ at: 55, ok: true, shift: 1.06 }],
  });
  assert.match(text, /变调：原速认不出/);
  assert.match(text, /×1.06/);
  assert.match(text, /可能不准/);
  assert.match(text, /扫到 2 首不同的歌/);
  assert.match(text, /1:15：Song B — Artist B（×1.12 变调）/);
});

test('未命中时把试过的时间点和建议写出来', () => {
  const text = formatResult({
    ok: false,
    video: { title: '某视频', duration: 200 },
    points: [30, 90, 150],
    clipSeconds: 12,
    tried: [{ at: 30 }, { at: 90, error: 'no audio' }],
  });
  assert.match(text, /没认出来/);
  assert.match(text, /已试：0:30 \/ 1:30/);
  assert.match(text, /at=75/);
  assert.match(text, /no audio/);
});

test('缓存读写 + TTL', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-cache-'));
  const file = path.join(dir, 'cache.json');
  try {
    put('k1', { ok: true, song: { title: 'x' } }, { file, now: 1000 });
    assert.deepEqual(get('k1', { file, now: 2000 }), { ok: true, song: { title: 'x' } });
    // 8 天后过期
    assert.equal(get('k1', { file, now: 1000 + 8 * 24 * 3600 * 1000 }), null);
    // 不存在的键
    assert.equal(get('nope', { file, now: 2000 }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存文件坏了当空库，不抛', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-cache-'));
  const file = path.join(dir, 'cache.json');
  try {
    put('k', 1, { file, now: 1 });
    writeFileSync(file, '{坏', 'utf8');
    assert.equal(get('k', { file, now: 2 }), null);
    // 坏文件还能被正常覆盖回去
    put('k', 2, { file, now: 3 });
    assert.equal(get('k', { file, now: 4 }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
