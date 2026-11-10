/**
 * pipeline/identify.js — 一条链接进，一首歌出。
 *
 * 顺序：归一化 → 查缓存 → 探元信息 → 取音频 → 切片 → Shazam → 写缓存。
 * 这里是唯一把各个 pipeline 模块串起来的地方；每一步都保持"能力可缺、失败可解释"。
 *
 * 三轮识别，一轮比一轮贵、一轮比一轮脏：
 *   1) 原速、均匀采样点 —— 正常 MV 到这一步就中了；
 *   2) 原速、补扫更多位置 —— DJ 串烧 / 混剪里每首歌只占几十秒，三个点很容易全落空；
 *   3) 变调重试 —— B 站大量"降调 0.95x / 升调 / 变速"投稿，Shazam 指纹认不出变调版。
 * 第 3 轮最容易误判：同一段音频换个倍率就可能指向另一首歌（实测同一条 DJ 串烧：×1.06、×1.12
 * 各指向一首歌，反而原速补扫认出的那首最可信）。
 * 所以变调试出来的东西标了 `shift`，渲染时必须提醒"可能不准"，多出来的候选一并交回去。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as cache from './cache.js';
import { cutClip, cutClipShifted } from './clips.js';
import {
  HARD_LIMIT, WHOLE_DOWNLOAD_LIMIT, downloadSection, downloadWhole, probeMedia, samplePoints,
} from './media.js';
import { matchNetease } from './netease.js';
import { recognizeClips, extractSong } from './shazam.js';
import { normalizeEngine } from './settings.js';
import { normalizeUrl, cacheKey } from './url.js';
import { ensureVendor, resolvePython } from './vendor.js';
import { requireFfmpeg, requireYtdlp } from './ytdlp.js';

/**
 * 变调重试用的倍率。实测（一条标着「降调 0.95x」的投稿）：
 * 理论值 1/0.95≈1.0526 认不出，×1.12 才命中 —— Shazam 的容错比想象中窄，
 * 一次只试一档很容易漏，所以给两档，先小后大。
 */
const SHIFT_RATIOS = [1.06, 1.12];

/** 补扫的点数：短视频（<30 分钟）才有整段音频，可以随便切。 */
const EXTRA_SCAN_POINTS = 7;

/**
 * 变调时试几个位置（每档一次调用，命中的是这一档里第一个中的点）。
 * 变调主要救"整条视频都是降调版"这种场景，但实测位置特别要紧：同一档 ×1.06 在某条
 * 串烧视频里只有少数几段能中，其它位置全空 —— 所以宁可多撒几个点。
 */
const SHIFT_POINTS = 5;

function tmpBase(env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'song-id', 'tmp');
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 在 [from, to] 上均匀撒 count 个点（按视频时长比例）。 */
function spreadPoints(duration, count, from = 0.08, to = 0.9) {
  if (!duration || !Number.isFinite(duration)) return [];
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? (from + to) / 2 : from + (to - from) * (i / (count - 1));
    points.push(Math.max(0, Math.round(duration * ratio)));
  }
  return points;
}

/** 去重：同一首歌被反复试没有意义，离已有点太近的点直接扔掉。 */
function uniquePoints(points, existing, minGap) {
  const kept = [];
  for (const point of points) {
    const tooClose = [...existing, ...kept].some((other) => Math.abs(other - point) < minGap);
    if (!tooClose) kept.push(point);
  }
  return kept;
}

/** 去重用的标题指纹：括号里的版本说明（Live / DJ版 / 翻自…）不该让同一首歌算成两首。 */
function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s\-_·、,，.!！?？]+/g, '');
}

/**
 * @param {{url:string, at?:number, clips?:number, clipSeconds?:number, cookies?:string,
 *   engine?:'auto'|'shazam'|'netease', env?:object, log?:Function, noCache?:boolean}} options
 */
export async function identify(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const started = Date.now();

  const url = normalizeUrl(options.url);
  // 引擎偏好来自设置页（「听歌识曲 → 选择引擎」）；auto = 两家都跑。
  const engine = normalizeEngine(options.engine);
  const clips = clampInt(options.clips, 3, 1, 5);
  const clipSeconds = clampInt(options.clipSeconds, 12, 5, 30);
  const at = Number.isFinite(Number(options.at)) ? Math.max(0, Number(options.at)) : null;
  const cookies = options.cookies || env.DSH_VIDEO_COOKIES || null;

  // 引擎进了缓存键：同一时间点换个引擎问，答案可能完全不同，不能拿旧结果糊弄
  const key = `${cacheKey(url)}|at=${at ?? ''}|n=${clips}|s=${clipSeconds}|e=${engine}`;
  if (!options.noCache) {
    const cached = cache.get(key, { file: cache.cacheFile(env) });
    if (cached) return { ...cached, cached: true, elapsedMs: Date.now() - started };
  }

  const ytdlp = requireYtdlp(env);
  const ffmpeg = requireFfmpeg(env);

  log('读视频信息…');
  const info = await probeMedia(ytdlp, url, { cookies });
  const duration = info.duration;
  if (!info.hasAudio) throw new Error('这个视频没有音轨，识别不了。');
  if (duration > HARD_LIMIT && at === null) {
    throw new Error(
      `视频有 ${Math.round(duration / 60)} 分钟，太长了。\n`
      + '请用 at 参数指定一个大概有歌的时间点（秒），例：at=180。',
    );
  }

  const points = samplePoints({ duration, at, clips, clipSeconds });
  const base = tmpBase(env);
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(path.join(base, 'run-'));

  try {
    // ── 取音频 ──────────────────────────────────────────────────────────
    // source 有值 = 手上是整段音频，可以任意 time 切片（补扫/变调都靠它）；
    // 为 null 时只有按需下载的那几个区间，切片只能从头切。
    let source = null;
    const sections = [];

    if (duration && duration > WHOLE_DOWNLOAD_LIMIT) {
      log('视频较长，只取需要的片段…');
      try {
        for (const point of points) {
          const file = await downloadSection(ytdlp, url, { start: point, seconds: clipSeconds + 1, outDir: work, cookies });
          sections.push({ point, path: file });
        }
      } catch (e) {
        log(`区间下载失败（${e?.message ?? e}），改成整段下载…`);
        source = await downloadWhole(ytdlp, url, { outDir: work, cookies, timeoutMs: 600_000 });
      }
    } else {
      log('取音频…');
      source = await downloadWhole(ytdlp, url, { outDir: work, cookies });
    }

    const nearestSection = (point) => {
      if (!sections.length) return null;
      let best = sections[0];
      for (const section of sections) {
        if (Math.abs(section.point - point) < Math.abs(best.point - point)) best = section;
      }
      return best;
    };

    const makeClip = async (point, ratio) => {
      const out = path.join(work, `c-${Math.round(point)}-${ratio}.mp3`);
      if (source) {
        return ratio === 1
          ? cutClip(ffmpeg, source, { start: point, seconds: clipSeconds, out })
          : cutClipShifted(ffmpeg, source, { start: point, seconds: clipSeconds, ratio, out });
      }
      const section = nearestSection(point);
      if (!section) throw new Error('没有可用的音频片段。');
      return ratio === 1
        ? cutClip(ffmpeg, section.path, { start: 0, seconds: clipSeconds, out })
        : cutClipShifted(ffmpeg, section.path, { start: 0, seconds: clipSeconds, ratio, out });
    };

    // ── 一轮识别 ────────────────────────────────────────────────────────
    const tried = [];
    const allHits = [];
    // 两家的前置不一样：只要网易云时不必装 shazamio（首次安装要下 21MB）；只要 Shazam 时不必起网易云的指纹。
    const wantShazam = engine !== 'netease';
    const wantNetease = engine !== 'shazam';
    const python = wantShazam ? await resolvePython(env) : null;
    let vendor = null;

    const runRound = async (label, plan, { retryMiss = false } = {}) => {
      const made = [];
      for (const item of plan) {
        try {
          made.push({ ...item, path: await makeClip(item.point, item.ratio) });
        } catch { /* 某一段切不出来不该毁掉整轮 */ }
      }
      if (!made.length) return null;
      if (wantShazam && !vendor) vendor = await ensureVendor({ python, log });
      log(label);
      const clipPaths = made.map((m) => m.path);

      // 两个引擎并行：Shazam（Apple 曲库）与网易云（用户可上传曲库，DJ 版/翻唱/AI 版多）。
      // 任何一个挂掉都不该拖垮另一个，所以各自 catch 成空结果。
      // 设置页选了单引擎时，另一个直接给空结果 —— 后续合并逻辑不用改。
      const emptyShazam = { ok: true, hit: null, hits: [], tried: [] };
      const emptyNetease = { ok: true, results: [], tried: [] };
      const [shazamSide, neteaseSide] = await Promise.all([
        wantShazam
          ? recognizeClips({ python, vendor: vendor.dir, clips: clipPaths, retryMiss })
            .then((r) => ({ ...r, ok: true }), (e) => ({ ok: false, error: e, hit: null, hits: [], tried: [] }))
          : Promise.resolve(emptyShazam),
        wantNetease
          ? matchNetease({ ffmpeg, clips: clipPaths, workDir: work, log })
            .then((r) => ({ ...r, ok: true }), (e) => ({ ok: false, error: e, results: [], tried: [] }))
          : Promise.resolve(emptyNetease),
      ]);

      // 按片段下标归集两家的命中；同一片段上 Shazam 的元数据更全，优先
      const perIndex = new Map();
      for (const entry of shazamSide.hits ?? []) {
        if (!made[entry.index]) continue;
        perIndex.set(entry.index, { shazam: extractSong(entry) });
      }
      for (const item of neteaseSide.results ?? []) {
        if (!made[item.index] || !item.songs?.length) continue;
        const slot = perIndex.get(item.index) ?? {};
        slot.netease = item.songs;
        perIndex.set(item.index, slot);
      }

      const stamp = (index) => {
        const item = made[index];
        return {
          at: item?.point ?? null,
          shift: item && item.ratio !== 1 ? item.ratio : undefined,
        };
      };
      for (const attempt of shazamSide.tried ?? []) {
        tried.push({ ...stamp(attempt.index), ok: Boolean(perIndex.get(attempt.index)?.shazam), error: attempt.error });
      }
      for (const attempt of neteaseSide.tried ?? []) {
        tried.push({ ...stamp(attempt.index), ok: Boolean(perIndex.get(attempt.index)?.netease), error: attempt.error, engine: 'netease' });
      }

      // 每一段的命中都收着：串烧视频里这是"这条视频扫到了哪些歌"的唯一来源
      const indexes = [...perIndex.keys()].sort((a, b) => a - b);
      for (const index of indexes) {
        const item = made[index];
        const slot = perIndex.get(index);
        if (slot.shazam) {
          // 这一段 Shazam 已经认出来了：网易云在同一位置给的候选基本都是撞库噪声
          // （实测原速下网易云会蹦出完全无关的歌，甚至同一首歌的另一个版本）
          allHits.push({ at: item.point, ratio: item.ratio, song: slot.shazam, engine: 'shazam' });
          continue;
        }
        for (const song of (slot.netease ?? []).slice(0, 2)) {
          allHits.push({ at: item.point, ratio: item.ratio, song, engine: 'netease' });
        }
      }

      // 第一个有结果的片段就是这一轮的战果；Shazam 有就用 Shazam 的
      const idx = indexes[0];
      if (idx === undefined) return null;
      const slot = perIndex.get(idx);
      const item = made[idx];
      const neteaseTop = slot.netease?.[0] ?? null;
      const song = slot.shazam
        ? { ...slot.shazam, engine: 'shazam' }
        : { ...neteaseTop, engine: 'netease' };
      return { song, point: item.point, ratio: item.ratio };
    };

    // 轮 1：原速、均匀采样
    let round = await runRound('识曲中…', points.map((p) => ({ point: p, ratio: 1 })));

    // 轮 2：原速、补扫（只在有整段音频、且用户没指定 at 时做；DJ 串烧里三个点太容易全落空）
    let scanPoints = [];
    if (!round && source && duration && at === null) {
      const candidates = spreadPoints(duration, EXTRA_SCAN_POINTS);
      scanPoints = uniquePoints(candidates, points, Math.max(clipSeconds, 8));
      if (scanPoints.length) {
        round = await runRound(
          `原速没中，再补扫 ${scanPoints.length} 个位置…`,
          scanPoints.map((p) => ({ point: p, ratio: 1 })),
        );
      }
    }

    // 轮 3：变调。两种情况要跑：
    //   a) 原速全没中 —— 整条视频就是降调/变速版；
    //   b) 只有网易云认出来了 —— 网易云原速的误配率不低（实测会蹦出完全无关的歌），
    //      而它变调后又常常指向真正的 DJ 版。这时不替换主答案，只把变调结果并进候选。
    if (!round || round.song?.engine === 'netease') {
      const candidates = duration && at === null
        ? uniquePoints(spreadPoints(duration, 9), [], Math.max(clipSeconds, 8))
        : uniquePoints([...scanPoints, ...points], [], Math.max(clipSeconds, 8));
      const shiftBase = candidates.slice(0, SHIFT_POINTS);
      for (const ratio of SHIFT_RATIOS) {
        // 变调片段更容易空手而回，但实测重试的收益不稳定（同一片段两次 74s 中、82s 空），
        // 而代价是整体耗时翻倍（82s → 181s）。默认不重试，把时间留给"多试几个位置"。
        const attempt = await runRound(
          `换个调门试试（×${ratio}，${shiftBase.length} 个位置）…`,
          shiftBase.map((p) => ({ point: p, ratio })),
          { retryMiss: false },
        );
        if (attempt && !round) round = attempt;
      }
    }

    // 把所有位置的命中汇总成"这条视频里扫到的歌"：串烧/混剪不同位置就是不同的歌，
    // 只报第一首等于骗人。同一个"歌名+歌手"只留最早出现的那次。
    const matches = [];
    const seenTitles = new Set();
    for (const item of allHits) {
      const song = item.song;
      if (!song?.title) continue;
      const key = titleKey(song.title);
      if (!key || seenTitles.has(key)) continue;
      seenTitles.add(key);
      matches.push({
        title: song.title,
        artist: song.artist,
        at: item.at,
        shift: item.ratio !== 1 ? item.ratio : null,
        engine: item.engine ?? 'shazam',
      });
      if (matches.length >= 8) break;
    }

    const common = {
      video: { title: info.title, duration, id: info.id, url: info.webpageUrl, uploader: info.uploader },
      points,
      clipSeconds,
      engines: [wantShazam ? 'shazam' : null, wantNetease ? 'netease' : null].filter(Boolean),
      engine: wantShazam ? 'shazam' : 'netease',
      elapsedMs: Date.now() - started,
    };

    if (!round) {
      // 没认出来不缓存：下次换个时间点可能就中了
      return { ...common, ok: false, song: null, tried, shift: null, matches: [], cached: false };
    }

    const song = round.song ?? {};
    const shift = round.ratio !== 1 ? round.ratio : null;
    const result = {
      ...common,
      ok: true,
      engine: round.song?.engine ?? 'shazam',
      song,
      playedAt: round.point,
      tried,
      shift,
      matches,
      cached: false,
    };
    cache.put(key, result, { file: cache.cacheFile(env) });
    return result;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch { /* 临时目录删不掉不该让工具失败 */ }
  }
}

export { clampInt, spreadPoints, uniquePoints };
