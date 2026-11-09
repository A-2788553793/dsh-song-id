/**
 * pipeline/cache.js — 记住认出来的结果。
 *
 * 同一个视频问第二遍，不该再下一次音频、再调一次 Shazam。
 * 缓存放 $DSH_HOME/storages/song-id/cache.json：跨会话共享，跟着 DSH 数据走。
 *
 * 读坏了就当没有（宁可贵一次，也不要因为缓存文件手抖就让工具不能使）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

export function cacheFile(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'song-id', 'cache.json');
}

function readAll(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') return data;
  } catch { /* 空、坏、没有 —— 都当空库 */ }
  return { version: 1, entries: {} };
}

export function get(key, { file = cacheFile(), now = Date.now() } = {}) {
  const store = readAll(file);
  const entry = store.entries[key];
  if (!entry) return null;
  if (now - Number(entry.at || 0) > TTL_MS) return null;
  return entry.value ?? null;
}

export function put(key, value, { file = cacheFile(), now = Date.now() } = {}) {
  const store = readAll(file);
  store.entries[key] = { at: now, value };

  // 超出上限时丢最旧的，别让这个文件无限长
  const keys = Object.keys(store.entries);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number(store.entries[a].at || 0) - Number(store.entries[b].at || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete store.entries[k]);
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  } catch { /* 写不进去就算了，缓存不是关键路径 */ }
}
