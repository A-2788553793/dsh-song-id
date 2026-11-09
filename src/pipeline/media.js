/**
 * pipeline/media.js — 元信息 + 取音频。
 *
 * 取音频有两条路，按视频长短选：
 *  - 短视频（默认 ≤ 30 分钟）：整段 bestaudio 下一次，10 MB 以内，最稳。
 *  - 长视频：`--download-sections` 只下需要的那几十秒。这条路依赖 yt-dlp/ffmpeg 的
 *    切割能力，站点不配合时会失败 —— 所以失败要回退，而不是直接报错。
 * 超过 60 分钟又没给 at 的，直接拒：默默下 200 MB 比"请你给个时间点"更糟。
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { explainYtdlpError, runProcess } from './ytdlp.js';

export const WHOLE_DOWNLOAD_LIMIT = 30 * 60; // 秒
export const HARD_LIMIT = 60 * 60;

function cookiesArgs(cookies) {
  return cookies ? ['--cookies', cookies] : [];
}

/** `yt-dlp -J`：只解析，不下载。 */
export async function probeMedia(bin, url, { cookies, timeoutMs = 60_000 } = {}) {
  const args = ['-J', '--no-warnings', '--no-playlist', ...cookiesArgs(cookies), url];
  const { stdout, stderr, code } = await runProcess(bin, args, { timeoutMs });
  if (code !== 0) throw new Error(explainYtdlpError(stderr));

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp 没吐出可解析的 JSON（链接可能不是单条视频）。');
  }
  if (info?.is_live) throw new Error('这是直播，没有固定的音频片段可识别。');
  if (info?._type === 'playlist') throw new Error('这是合集/播放列表，请给具体某一集的链接。');

  const duration = Number(info?.duration) || 0;
  return {
    title: info?.title || '',
    duration,
    uploader: info?.uploader || info?.channel || '',
    id: info?.id || '',
    webpageUrl: info?.webpage_url || url,
    hasAudio: pickHasAudio(info),
  };
}

/** 有些视频压根没音轨（纯画面/无声素材），早点说比下完再说好。 */
function pickHasAudio(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  if (!formats.length) return true; // 拿不到 format 列表就不预判
  return formats.some((f) => f?.acodec && f.acodec !== 'none');
}

/**
 * 采样点：默认按比例铺在视频里，避开开头（logo/片头曲）和结尾（片尾字幕）。
 * 给了 at 就从 at 起连续取。
 */
export function samplePoints({ duration, at, clips = 3, clipSeconds = 12 }) {
  const rawSpan = Math.floor(Number(clipSeconds));
  const span = Number.isFinite(rawSpan) ? Math.max(5, Math.min(30, rawSpan)) : 12;
  const rawClips = Math.floor(Number(clips));
  const n = Number.isFinite(rawClips) ? Math.max(1, Math.min(5, rawClips)) : 3;
  const points = [];

  if (Number.isFinite(at) && at >= 0) {
    for (let i = 0; i < n; i += 1) {
      const start = at + i * span;
      if (duration && start >= duration - 1) break;
      points.push(Math.round(start * 100) / 100);
    }
    if (points.length) return points;
  }

  if (!duration) return [0];
  const last = Math.max(0, duration - span - 1);
  // 12% → 72%：开头有 logo/片头曲，结尾有字幕，两头都别浪费
  const ratios = n === 1 ? [0.4] : Array.from({ length: n }, (_, i) => 0.12 + (0.6 * i) / (n - 1));
  for (const r of ratios) points.push(Math.round(Math.min(last, duration * r) * 100) / 100);
  return points;
}

function findProduced(outDir, prefix) {
  let names = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return null;
  }
  const hits = names
    .filter((n) => n.startsWith(prefix) && !n.endsWith('.part') && !n.endsWith('.ytdl'))
    .map((n) => path.join(outDir, n))
    .filter((p) => {
      try {
        return statSync(p).size > 1024;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).size - statSync(a).size);
  return hits[0] || null;
}

/** 整段 bestaudio。返回落盘路径。 */
export async function downloadWhole(bin, url, { outDir, cookies, timeoutMs = 240_000 } = {}) {
  const template = path.join(outDir, 'full.%(ext)s');
  const args = ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', ...cookiesArgs(cookies), '-o', template, url];
  const { stderr, code } = await runProcess(bin, args, { timeoutMs });
  const file = findProduced(outDir, 'full.');
  if (code !== 0 || !file) throw new Error(explainYtdlpError(stderr) || 'yt-dlp 没产出音频文件。');
  return file;
}

/** 只下 [start, start+seconds) 这一段。失败抛错，由调用方决定要不要回退。 */
export async function downloadSection(bin, url, { start, seconds, outDir, cookies, timeoutMs = 180_000 } = {}) {
  const end = start + seconds;
  const template = path.join(outDir, `seg-${Math.round(start)}.%(ext)s`);
  const args = [
    '-f', 'bestaudio/best', '--no-playlist', '--no-warnings',
    ...cookiesArgs(cookies),
    '--download-sections', `*${start}-${end}`,
    '-o', template, url,
  ];
  const { stderr, code } = await runProcess(bin, args, { timeoutMs });
  const file = findProduced(outDir, `seg-${Math.round(start)}.`);
  if (code !== 0 || !file) throw new Error(explainYtdlpError(stderr) || '区间下载失败。');
  return file;
}
