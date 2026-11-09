/**
 * pipeline/ytdlp.js — 找 yt-dlp、跑子进程。
 *
 * 两条红线（照着 dsh-video-storyboard 踩过的坑写的）：
 *  1. **argv 数组，永远不过 shell** —— 链接里一个 `&` 就能变成命令拼接。
 *  2. 找不到就算找不到，不要假装有：抛带安装指引的错，让用户自己决定装不装。
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const COOKIES_ENV = 'DSH_VIDEO_COOKIES';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/** 候选路径，按可信度排序。只用于探测，不保证都存在。 */
export function ytdlpCandidates(env = process.env) {
  const out = [];
  if (env.DSH_YTDLP_PATH) out.push(env.DSH_YTDLP_PATH);

  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir) out.push(path.join(dir, `yt-dlp${EXE}`));
  }

  // pip install --user 的落地位置：%APPDATA%\Python\Python3xx\Scripts
  if (env.APPDATA) {
    const root = path.join(env.APPDATA, 'Python');
    try {
      for (const d of readdirSync(root)) out.push(path.join(root, d, 'Scripts', `yt-dlp${EXE}`));
    } catch { /* 没有就算了 */ }
  }
  if (env.LOCALAPPDATA) {
    out.push(path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Scripts', `yt-dlp${EXE}`));
  }
  return [...new Set(out)];
}

export function findYtdlp(env = process.env) {
  for (const candidate of ytdlpCandidates(env)) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch { /* 无权限的目录跳过 */ }
  }
  return null;
}

export function requireYtdlp(env = process.env) {
  const bin = findYtdlp(env);
  if (bin) return bin;
  throw new Error(
    '没找到 yt-dlp，拿不到视频音频。装一个：\n'
    + '  pip install -U yt-dlp\n'
    + '或从 https://github.com/yt-dlp/yt-dlp/releases 下载 exe 放进 PATH，\n'
    + '再用环境变量 DSH_YTDLP_PATH 指给我也行。',
  );
}

export function requireFfmpeg(env = process.env) {
  const name = `ffmpeg${EXE}`;
  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  if (env.DSH_FFMPEG_PATH && existsSync(env.DSH_FFMPEG_PATH)) return env.DSH_FFMPEG_PATH;
  throw new Error('没找到 ffmpeg（切片段要用）。装一个并放进 PATH，或用 DSH_FFMPEG_PATH 指定。');
}

/**
 * 跑一个子进程，收集 stdout/stderr。
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
export function runProcess(bin, args, { timeoutMs = 120_000, env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, env, cwd });
    } catch (e) {
      reject(new Error(`起不来 ${bin}: ${e?.message ?? e}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const limit = 8 * 1024 * 1024; // yt-dlp -J 的 formats 能很大，但 8MB 到头了

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`${path.basename(bin)} 超过 ${Math.round(timeoutMs / 1000)} 秒没结束（${args.slice(0, 2).join(' ')}…）`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`跑 ${path.basename(bin)} 出错：${e?.message ?? e}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/** 把 yt-dlp 的报错压成一句人话。 */
export function explainYtdlpError(stderr) {
  const text = String(stderr || '');
  if (/Sign in to confirm|login required|需要登录|大会员|Premium/i.test(text)) {
    return '这个视频要登录/会员才能拿音频。导出一份 cookies.txt 后用 cookies 参数指给我（或设 DSH_VIDEO_COOKIES）。';
  }
  if (/This video is unavailable|not available|404/i.test(text)) return '视频不可用（可能被删、被锁区或链接错了）。';
  if (/Unsupported URL/i.test(text)) return 'yt-dlp 不认识这个链接。';
  if (/HTTP Error 403/i.test(text)) return '站点拒绝了请求（403），多半需要 cookies。';
  const last = text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
  return last ? `yt-dlp 报错：${last}` : 'yt-dlp 跑失败了，没有更多信息。';
}
