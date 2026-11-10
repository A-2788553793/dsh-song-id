/**
 * pipeline/settings.js — 用户在设置页里选的「引擎偏好」。
 *
 * 只有一件事：把「自动 / 只 Shazam / 只网易云」这个选择落盘并读回来。
 * 文件放在 $DSH_HOME/storages/song-id/settings.json，和缓存同一个目录；
 * 文件坏了、被手改乱了、根本不存在，一律回落到 auto —— 识曲本身不该因为偏好读不出来而失败。
 *
 * 同步读写：文件只有一行 JSON，且只在用户点选设置页时发生，异步写反而要处理竞态。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 三个可选值。auto = 两个引擎都跑（默认行为）。 */
export const ENGINES = ['auto', 'shazam', 'netease'];

export function settingsFile(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'song-id', 'settings.json');
}

/** 任何脏值都归 auto：设置页只有一个下拉，没有"未知"这种状态。 */
export function normalizeEngine(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ENGINES.includes(v) ? v : 'auto';
}

export function readSettings(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(env), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { engine: 'auto' };
    // 保留文件里其它字段：以后加偏好时，老版本插件写回不会把它们冲掉
    return { ...parsed, engine: normalizeEngine(parsed.engine) };
  } catch {
    return { engine: 'auto' };
  }
}

/** 合并写：以后再加字段时不会把已有偏好冲掉。 */
export function writeSettings(env = process.env, patch = {}) {
  const next = { ...readSettings(env), ...patch };
  next.engine = normalizeEngine(next.engine);
  const file = settingsFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
