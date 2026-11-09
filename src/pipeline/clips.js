/**
 * pipeline/clips.js — ffmpeg 切片。
 *
 * Shazam 的识别质量跟这一段有关系，但没那么娇气：16 kHz 单声道 mp3 就够，
 * 一个 12 秒片段约 60 KB —— 大小不是问题，问题是别把整段视频塞给 python。
 */

import { statSync } from 'node:fs';
import { runProcess } from './ytdlp.js';

const SAMPLE_RATE = 16000;

/**
 * 变速+变调的滤镜链。B 站上"降调 0.95x""dj 升调"这类投稿满地跑，
 * Shazam 的指纹对音高/速度变化不鲁棒 —— 原速认不出时，把片段变回原调再问一次。
 *
 * asetrate 作用在**输入流的采样率**上，所以必须先把源重采样到统一采样率，
 * 否则 48 kHz 的源会被当成 16 kHz 处理，变成 3 倍速的怪东西。
 */
export function shiftFilter(ratio, sampleRate = SAMPLE_RATE) {
  const rate = Math.round(sampleRate * ratio);
  return `aresample=${sampleRate},asetrate=${rate},aresample=${sampleRate}`;
}

/**
 * 从音频/视频里切出 [start, start+seconds) 并压成 mp3。
 * `-ss` 放在 `-i` 前面是**快速定位**（关键帧跳跃），慢的精确解码没必要。
 */
export async function cutClip(ffmpeg, src, { start = 0, seconds = 12, out, timeoutMs = 60_000 }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start),
    '-t', String(seconds),
    '-i', src,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '96k',
    '-f', 'mp3',
    out,
  ];
  const { stderr, code } = await runProcess(ffmpeg, args, { timeoutMs });
  if (code !== 0) {
    const tail = String(stderr || '').trim().split(/\r?\n/).slice(-2).join(' / ');
    throw new Error(`ffmpeg 切片失败：${tail}`);
  }
  let size = 0;
  try {
    size = statSync(out).size;
  } catch { /* 下面统一报 */ }
  if (size < 1024) throw new Error('ffmpeg 切出来的片段是空的（这个时间点可能没声音）。');
  return out;
}

/**
 * 切片 + 变调（更快也更小，用于"原速认不出"的第二轮）。
 * ratio > 1 = 升调加速（可把"降调版"还原回原曲），ratio < 1 = 降调减速。
 */
export async function cutClipShifted(ffmpeg, src, { start = 0, seconds = 12, ratio = 1.1, out, timeoutMs = 60_000 }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start),
    '-t', String(seconds),
    '-i', src,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-af', shiftFilter(ratio),
    '-b:a', '96k',
    '-f', 'mp3',
    out,
  ];
  const { stderr, code } = await runProcess(ffmpeg, args, { timeoutMs });
  if (code !== 0) {
    const tail = String(stderr || '').trim().split(/\r?\n/).slice(-2).join(' / ');
    throw new Error(`ffmpeg 变调切片失败：${tail}`);
  }
  let size = 0;
  try {
    size = statSync(out).size;
  } catch { /* 下面统一报 */ }
  if (size < 1024) throw new Error('变调后的片段是空的。');
  return out;
}
