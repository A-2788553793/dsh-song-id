/**
 * pipeline/netease.js — 网易云音乐的"听歌识曲"接口。
 *
 * 网易云的网页版识曲是纯前端的：把 3 秒 8 kHz 单声道 PCM 交给一个 wasm 算指纹，
 * 再把指纹 base64 塞进 query 递给 `interface.music.163.com/api/music/audio/match`。
 * 整个链路不需要登录、不需要 key、不需要加密签名 —— 所以插件可以直接自己算指纹。
 *
 * 之所以值得加这个引擎（而不是只用 Shazam）：网易云的曲库是"用户可上传"的，
 * 里面塞满了 DJ 版、翻唱版、AI 版、伴奏。实测一条 DJ 降调投稿：
 *   - Shazam 变调后只认到原唱；
 *   - 网易云在 ×1.06 直接认到了曲库里对应的 DJ 版 —— 正是这条视频放的版本。
 * 两家的指纹都源自 Shazam 系算法（接口参数 algorithmCode=shazam_v2），对变调一样不鲁棒，
 * 但**曲库**不同，所以结果互补。
 *
 * vendor/afp/ 里的 afp.wasm.js 来自 https://github.com/mos9527/ncm-afp ，
 * 经 NeteaseCloudMusicApi 的 demo 分发；只做本地指纹计算，不上传任何东西。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { runProcess } from './ytdlp.js';

const AFP_PATH = fileURLToPath(new URL('../../vendor/afp/afp.cjs', import.meta.url));
const ENDPOINT = 'https://interface.music.163.com/api/music/audio/match';

/** 网易云只吃 3 秒、8 kHz 单声道 —— 这也让单个片段的识别只要几百毫秒。 */
const CLIP_SECONDS = 3;
const SAMPLE_RATE = 8000;
const CONCURRENCY = 3;

/**
 * 一个 12 秒片段里取几个 3 秒窗口去问。窗口多一点很便宜（一次查询 ~200 ms），
 * 而 DJ 混音里 3 秒的偏移就足够让指纹落到另一首歌上 —— 实测同一条 12 秒片段，
 * 从 73 秒起问和从 79 秒起问，答案能完全不同。
 */
const WINDOWS = [0, 6];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let afpModule = null;
function loadAfp() {
  if (!afpModule) {
    // afp.cjs 是 CommonJS（Emscripten 产物），ESM 里得用 createRequire 拉进来
    const require = createRequire(import.meta.url);
    afpModule = require(AFP_PATH);
  }
  return afpModule;
}

/** 把 mp3 片段（从 offset 秒起）转成 Float32 PCM（3 秒 / 8 kHz / 单声道），喂给指纹器。 */
async function toPcm(ffmpeg, clipPath, rawPath, offset = 0) {
  const { stderr, code } = await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(offset > 0 ? ['-ss', String(offset)] : []),
    '-t', String(CLIP_SECONDS),
    '-i', clipPath,
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 'f32le',
    rawPath,
  ], { timeoutMs: 30_000 });
  if (code !== 0) {
    const tail = String(stderr || '').trim().split(/\r?\n/).slice(-2).join(' / ');
    throw new Error(`ffmpeg 转 PCM 失败：${tail}`);
  }
  const buf = readFileSync(rawPath);
  // slice 出一份独立的 ArrayBuffer：Buffer 可能来自 pool，byteOffset 不保证 4 字节对齐
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const samples = new Float32Array(bytes);
  return samples.length > CLIP_SECONDS * SAMPLE_RATE
    ? samples.subarray(0, CLIP_SECONDS * SAMPLE_RATE)
    : samples;
}

/**
 * 调接口。返回的 result 里每条带 startTime（毫秒），是"在曲库版本里的位置"，
 * 不是视频里的位置 —— 别拿它当命中位置用。
 */
async function query(fp, { timeoutMs = 15_000 } = {}) {
  const qs = new URLSearchParams({
    sessionId: '0123456789abcdef',
    algorithmCode: 'shazam_v2',
    duration: String(CLIP_SECONDS),
    rawdata: fp,
    times: '1',
    decrypt: '1',
  });
  const res = await fetch(`${ENDPOINT}?${qs.toString()}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`网易云接口返回 HTTP ${res.status}`);
  return res.json();
}

/** 把网易云返回的原始 JSON 压成和 Shazam 侧同构的小对象数组。 */
export function parseNeteasePayload(json) {
  const data = json?.data ?? {};
  const list = Array.isArray(data.result) ? data.result : [];
  const out = [];
  for (const entry of list) {
    const song = entry?.song ?? {};
    const title = String(song.name || '').trim();
    if (!title) continue;
    const artists = Array.isArray(song.artists)
      ? song.artists.map((a) => String(a?.name || '').trim()).filter(Boolean)
      : [];
    const album = song.album ?? {};
    out.push({
      title,
      artist: artists.join(' / '),
      album: String(album.name || '').trim(),
      cover: String(album.picUrl || album.blurPicUrl || '').trim(),
      url: song.id ? `https://music.163.com/song?id=${song.id}` : '',
      id: song.id ? String(song.id) : '',
      engine: 'netease',
    });
  }
  return out;
}

/**
 * 对一批本地片段逐个问网易云。
 *
 * @param {{ffmpeg:string, clips:string[], workDir:string, timeoutMs?:number, log?:Function}} options
 * @returns {Promise<{results:{index:number, songs:object[]}[], tried:{index:number, ok:boolean, error?:string}[]}>}
 *   results 只含"认出来了"的片段，每个片段最多取接口返回的前 3 条候选。
 */
export async function matchNetease({ ffmpeg, clips, workDir, timeoutMs = 90_000, log = () => {} }) {
  const results = [];
  const tried = [];
  if (!clips.length) return { results, tried };

  const started = Date.now();
  let cursor = 0;

  const worker = async () => {
    while (cursor < clips.length) {
      const index = cursor;
      cursor += 1;
      const found = [];
      let lastError = '';
      for (const offset of WINDOWS) {
        const raw = `${workDir}/ncm-${index}-${offset}.raw`;
        try {
          const pcm = await toPcm(ffmpeg, clips[index], raw, offset);
          // 片段比窗口短（例如只剩最后几秒）时就没有意义了
          if (pcm.length < SAMPLE_RATE) continue;
          const fp = await loadAfp().GenerateFP(pcm);
          const json = await query(fp, { timeoutMs: Math.min(timeoutMs, 15_000) });
          found.push(...parseNeteasePayload(json));
        } catch (e) {
          lastError = String(e?.message ?? e);
        }
      }
      // 不同窗口常常指向同一首，按 歌名+歌手 去重，保留先出现的
      const seen = new Set();
      const songs = [];
      for (const song of found) {
        const key = `${song.title}|${song.artist}`;
        if (seen.has(key)) continue;
        seen.add(key);
        songs.push(song);
        if (songs.length >= 3) break;
      }
      if (songs.length) results.push({ index, songs });
      tried.push({ index, ok: songs.length > 0, ...(songs.length ? {} : { error: lastError }) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clips.length) }, worker));
  log(`网易云识别 ${clips.length} 段，用时 ${Date.now() - started}ms`);
  return { results: results.sort((a, b) => a.index - b.index), tried };
}
