/**
 * 引擎偏好的自检：设成什么、读回来是什么，坏文件不许把识曲搞挂。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeEngine, readSettings, settingsFile, writeSettings } from '../src/pipeline/settings.js';

function tempEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-settings-'));
  return { env: { DSH_HOME: dir }, dir };
}

test('normalizeEngine：非法值一律回 auto', () => {
  assert.equal(normalizeEngine('shazam'), 'shazam');
  assert.equal(normalizeEngine('NETEASE'), 'netease');
  assert.equal(normalizeEngine('  auto  '), 'auto');
  assert.equal(normalizeEngine('kugou'), 'auto');
  assert.equal(normalizeEngine(''), 'auto');
  assert.equal(normalizeEngine(undefined), 'auto');
  assert.equal(normalizeEngine(42), 'auto');
});

test('没有设置文件时读出来是 auto', () => {
  const { env, dir } = tempEnv();
  try {
    assert.deepEqual(readSettings(env), { engine: 'auto' });
    assert.equal(settingsFile(env), path.join(dir, 'storages', 'song-id', 'settings.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写进去能读回来，目录会被自动建出来', () => {
  const { env, dir } = tempEnv();
  try {
    const written = writeSettings(env, { engine: 'netease' });
    assert.equal(written.engine, 'netease');
    assert.equal(readSettings(env).engine, 'netease');

    // 再写一次走的是合并路径：只改 engine，不把文件内容清空
    writeSettings(env, { engine: 'shazam' });
    assert.equal(readSettings(env).engine, 'shazam');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件坏掉时回落 auto，不抛错', () => {
  const { env, dir } = tempEnv();
  try {
    const file = settingsFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 json', 'utf8');
    assert.deepEqual(readSettings(env), { engine: 'auto' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件里是陌生值时的落盘会被规范成 auto', () => {
  const { env, dir } = tempEnv();
  try {
    const file = settingsFile(env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ engine: 'kugou', keep: 1 }), 'utf8');
    const next = writeSettings(env, {});
    assert.equal(next.engine, 'auto');
    assert.equal(next.keep, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
