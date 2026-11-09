/**
 * pipeline/shazam.js — 调 recognize.py，把 Shazam 的原始 JSON 压成我们要的样子。
 *
 * 输出噪声很多：aiohttp 在解释器退出时会打 "Unclosed client session" 一类的警告，
 * 而且全在 stdout 上。所以约定一个哨兵行 `<<<SONGID>>>`，只认它。
 */

import { fileURLToPath } from 'node:url';
import { runProcess } from './ytdlp.js';

const MARK = '<<<SONGID>>>';
const SCRIPT = fileURLToPath(new URL('./recognize.py', import.meta.url));

function parsePayload(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const at = line.indexOf(MARK);
    if (at < 0) continue;
    try {
      return JSON.parse(line.slice(at + MARK.length));
    } catch { /* 继续往前找 */ }
  }
  return null;
}

/**
 * @param {string[]} clips  本地片段路径，按想尝试的顺序
 * @returns {Promise<{hit:object|null, hits:object[], tried:object[]}>} hits 是所有命中（含 hit 本身）
 */
export async function recognizeClips({ python, vendor, clips, timeoutMs = 150_000, retryMiss = false }) {
  if (!clips.length) return { hit: null, hits: [], tried: [] };
  const args = [SCRIPT, ...clips];
  if (retryMiss) args.push('--retry-miss');
  const { stdout, stderr, code } = await runProcess(python, args, {
    // PYTHONIOENCODING 是双保险：recognize.py 自己也会 reconfigure，但 python 如果有
    // 早期 warning/异常先落到 stderr，那时 reconfigure 还没执行。
    env: { ...process.env, PYTHONPATH: vendor, PYTHONIOENCODING: 'utf-8' },
    timeoutMs,
  });

  const payload = parsePayload(stdout, stderr);
  if (!payload) {
    const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' / ');
    throw new Error(`识曲脚本没返回结果（退出码 ${code}）${tail ? `：${tail}` : ''}`);
  }
  if (payload.error) throw new Error(`识曲脚本报错：${payload.error}`);
  const hits = Array.isArray(payload.hits) ? payload.hits : (payload.hit ? [payload.hit] : []);
  return { hit: payload.hit ?? null, hits, tried: Array.isArray(payload.tried) ? payload.tried : [] };
}

/** Shazam 把专辑塞在 sections[].metadata 里，得自己翻。 */
function metadataValue(track, key) {
  const sections = Array.isArray(track?.sections) ? track.sections : [];
  for (const section of sections) {
    const metadata = Array.isArray(section?.metadata) ? section.metadata : [];
    for (const item of metadata) {
      if (String(item?.title || '').toLowerCase() === key.toLowerCase()) return String(item?.text || '');
    }
  }
  return '';
}

/** 把原始 track 摘成展示用的小对象。 */
export function extractSong(hit) {
  const track = hit?.track ?? {};
  const match = Array.isArray(hit?.matches) ? hit.matches[0] : null;
  return {
    title: String(track.title || track.subtitle || '').trim(),
    artist: String(track.subtitle || '').trim(),
    album: metadataValue(track, 'Album') || String(match?.album || '').trim(),
    label: metadataValue(track, 'Label'),
    released: metadataValue(track, 'Released'),
    genre: String(track?.genres?.primary || '').trim(),
    cover: String(track?.images?.coverart || track?.images?.coverarthq || '').trim(),
    shazamUrl: String(track?.url || '').trim(),
    appleMusic: String(track?.hub?.actions?.[0]?.uri || '').trim(),
    id: String(track?.key || '').trim(),
  };
}
