/**
 * pipeline/url.js — 把用户随手写的东西变成 yt-dlp 能吃的链接。
 *
 * 用户会这样给：
 *   BVxxxxxxxxxx
 *   https://www.bilibili.com/video/BVxxxxxxxxxx/?spm_id_from=333.1007
 *   b23.tv/xxxxxx
 *   https://youtu.be/xxxx
 * 前三种只有第一种需要拼，其他一律原样交给 yt-dlp —— 它自己认得短链。
 */

const BV = /^BV[0-9A-Za-z]{10}$/;
const AV = /^av(\d+)$/i;
const BARE_HOST = /^(?:www\.|m\.)?(?:bilibili\.com|b23\.tv|youtu\.be|youtube\.com|music\.youtube\.com|douyin\.com|tiktok\.com)\//i;

export function normalizeUrl(raw) {
  const s = String(raw ?? '').trim().replace(/^<|>$/g, '');
  if (!s) throw new Error('url 不能为空');
  if (/^https?:\/\//i.test(s)) return s;
  if (BV.test(s)) return `https://www.bilibili.com/video/${s}`;
  if (AV.test(s)) return `https://www.bilibili.com/video/${s.toLowerCase()}`;
  if (BARE_HOST.test(s)) return `https://${s}`;
  throw new Error(`不认识的输入：${s}\n要 B 站链接 / BV 号 / b23.tv 短链，或任意 yt-dlp 支持的视频链接。`);
}

/** 从链接里抠出 BV 号（拿不到就 null）—— 只用于展示和缓存键的稳定化。 */
export function bvOf(url) {
  const m = /(BV[0-9A-Za-z]{10})/.exec(url);
  return m ? m[1] : null;
}

/**
 * 缓存键：同一条视频换个 query 参数（spm_id_from、vd_source…）不该重算。
 * B 站用 BV 号做键；其他站点去掉 hash 与常见跟踪参数。
 */
export function cacheKey(url) {
  const bv = bvOf(url);
  if (bv) {
    const p = /[?&]p=(\d+)/.exec(url);
    return `bilibili:${bv}${p ? `:p${p[1]}` : ''}`;
  }
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of ['spm_id_from', 'vd_source', 'share_source', 'share_medium', 't', 'si', 'feature']) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}
