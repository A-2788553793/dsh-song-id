#!/usr/bin/env node
/**
 * bin/doctor.mjs — 依赖自检。装之前或"突然不好使了"的时候跑这个：
 *   node bin/doctor.mjs
 * 只报告，不修（修东西要用户点头）。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findYtdlp, runProcess } from '../src/pipeline/ytdlp.js';
import { resolvePython, vendorDir } from '../src/pipeline/vendor.js';

const ok = (label, detail) => console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, detail) => console.log(`⚠️  ${label}${detail ? ` — ${detail}` : ''}`);

async function main() {
  console.log('dsh-song-id 依赖自检\n');

  // 1. yt-dlp
  const ytdlp = findYtdlp();
  if (!ytdlp) {
    bad('yt-dlp', '没找到。pip install -U yt-dlp，或用 DSH_YTDLP_PATH 指定');
  } else {
    try {
      const { stdout, code } = await runProcess(ytdlp, ['--version'], { timeoutMs: 30_000 });
      if (code === 0) ok('yt-dlp', `${stdout.trim()}（${ytdlp}）`);
      else bad('yt-dlp', `跑 --version 失败：${ytdlp}`);
    } catch (e) {
      bad('yt-dlp', e?.message ?? String(e));
    }
  }

  // 2. ffmpeg
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  let ffmpeg = null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, ffmpegName))) {
      ffmpeg = path.join(dir, ffmpegName);
      break;
    }
  }
  if (!ffmpeg) {
    bad('ffmpeg', '不在 PATH 上（切片要用）。装一个并放进 PATH，或设 DSH_FFMPEG_PATH');
  } else {
    try {
      const { stdout } = await runProcess(ffmpeg, ['-version'], { timeoutMs: 20_000 });
      ok('ffmpeg', stdout.split(/\r?\n/)[0]);
    } catch (e) {
      bad('ffmpeg', e?.message ?? String(e));
    }
  }

  // 3. python
  let python = null;
  try {
    python = await resolvePython();
    ok('python', python);
  } catch (e) {
    bad('python', e?.message ?? String(e));
  }

  // 4. shazamio
  const dir = vendorDir();
  if (!python) {
    warn('shazamio', '先修好 python');
  } else if (!existsSync(dir)) {
    warn('shazamio', `还没装（首次识曲会自动装到 ${dir}）`);
  } else {
    try {
      const { code } = await runProcess(python, ['-c', 'import shazamio;print(shazamio.__name__)'], {
        env: { ...process.env, PYTHONPATH: dir },
        timeoutMs: 40_000,
      });
      if (code === 0) ok('shazamio', dir);
      else warn('shazamio', `${dir} 里装了但 import 不了，删掉目录重跑一次识曲即可重装`);
    } catch (e) {
      warn('shazamio', e?.message ?? String(e));
    }
  }

  // 5. 网易云引擎：本地指纹器 + 接口可达性
  try {
    const require = createRequire(import.meta.url);
    const afpPath = fileURLToPath(new URL('../vendor/afp/afp.cjs', import.meta.url));
    const afp = require(afpPath);
    if (typeof afp?.GenerateFP === 'function') ok('网易云指纹器', 'vendor/afp');
    else warn('网易云指纹器', '加载了但没导出 GenerateFP');
  } catch (e) {
    warn('网易云指纹器', `加载失败：${e?.message ?? e}`);
  }
  try {
    const res = await fetch('https://interface.music.163.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(6_000),
    });
    ok('网易云接口', `可达（HTTP ${res.status}）`);
  } catch (e) {
    warn('网易云接口', `连不上（${e?.message ?? e}）—— Shazam 引擎仍可用`);
  }

  console.log('\n缓存目录：', path.join(process.env.DSH_HOME || '~/.dsh', 'storages', 'song-id'));
}

main().catch((e) => {
  console.error('自检本身挂了：', e?.stack ?? e);
  process.exit(1);
});
