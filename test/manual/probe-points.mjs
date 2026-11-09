#!/usr/bin/env node
/**
 * 一次性诊断脚本（不入库）：把一条视频在多个时间点、多个变调档位各切一段送去 Shazam，
 * 看哪个（歌名,歌手）反复出现 —— 变调识别单点不可信，重复出现才有意义。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cutClipShifted } from '../../src/pipeline/clips.js';
import { extractSong, recognizeClips } from '../../src/pipeline/shazam.js';
import { requireFfmpeg } from '../../src/pipeline/ytdlp.js';

const url = process.argv[2];
const points = process.argv.slice(3).map(Number);
const RATIOS = [1.0, 1.06, 1.12];
const SECONDS = 15;

const ffmpeg = requireFfmpeg(process.env);
const PYTHON = 'C:/Users/a/.dsh/venvs/ppt-master/Scripts/python.exe';
const VENDOR = path.resolve(import.meta.dirname, '../../vendor/py');
const YTDLP = 'C:/Users/a/AppData/Roaming/Python/Python312/Scripts/yt-dlp.exe';

const work = path.join(os.tmpdir(), `songid-probe-${Date.now()}`);
mkdirSync(work, { recursive: true });

console.log(`下载音频… → ${work}`);
execFileSync(YTDLP, ['-f', 'bestaudio/best', '--no-warnings', '-o', path.join(work, 'a.%(ext)s'), url], { stdio: 'inherit' });
const src = readdirSync(work).filter((f) => f.startsWith('a.')).map((f) => path.join(work, f))[0];
console.log(`源文件 ${src} ${(statSync(src).size / 1048576).toFixed(1)}MB`);

const tally = new Map();
for (const ratio of RATIOS) {
  const clips = [];
  for (const point of points) {
    const out = path.join(work, `c-${point}-${ratio}.mp3`);
    clips.push(await cutClipShifted(ffmpeg, src, { start: point, seconds: SECONDS, ratio, out }));
  }
  // 一个片段一次调用：recognize.py 是"命中即停"，批量送进去只会看到第一个结果
  for (let i = 0; i < clips.length; i += 1) {
    const point = points[i];
    const { hit, tried } = await recognizeClips({ python: PYTHON, vendor: VENDOR, clips: [clips[i]] });
    if (hit) {
      const song = extractSong(hit);
      const key = `${song.title ?? '?'} — ${song.artist ?? '?'}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      console.log(`  ×${ratio} @ ${point}s 命中：${key}（Shazam id ${song.id ?? '?'}）`);
    } else {
      const err = tried[0]?.error;
      console.log(`  ×${ratio} @ ${point}s miss${err ? ` (${err})` : ''}`);
    }
  }
}

console.log('\n=== 统计 ===');
for (const [key, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${n} 次  ${key}`);
}
if (!tally.size) console.log('（全 miss）');

rmSync(work, { recursive: true, force: true });
