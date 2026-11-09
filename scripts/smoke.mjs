#!/usr/bin/env node
/**
 * scripts/smoke.mjs — 端到端冒烟：真的去认一首歌。
 *   node scripts/smoke.mjs https://www.bilibili.com/video/BVxxxxxxxxxx
 *   node scripts/smoke.mjs BVxxxxxxxxxx 70        # 从第 70 秒开始
 *   node scripts/smoke.mjs BVxxxxxxxxxx --fresh   # 不吃缓存，重新识别
 */

import { formatResult } from '../src/format.js';
import { identify } from '../src/pipeline/identify.js';

const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const positionals = argv.filter((a) => a !== '--fresh');
const url = positionals[0];
const at = positionals[1] ? Number(positionals[1]) : undefined;

if (!url) {
  console.error('用法：node scripts/smoke.mjs <视频链接或 BV 号> [起始秒] [--fresh]');
  process.exit(2);
}

console.error(`→ ${url}${at !== undefined ? ` @ ${at}s` : ''}${fresh ? '（忽略缓存）' : ''}`);
const started = Date.now();

try {
  const result = await identify({ url, at, noCache: fresh, log: (m) => console.error(`   … ${m}`) });
  console.log(formatResult(result));
  console.error(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!result.ok) process.exitCode = 2;
} catch (e) {
  console.error(`\n失败：${e?.message ?? e}`);
  process.exitCode = 1;
}
