/**
 * format.js — 结果 → 给人看的一段 markdown。
 *
 * 工具输出是"文本块"，模型和用户看的是同一份字。所以这里的原则是：
 * 第一行就把话说完（歌名 — 歌手），后面才是细节；没认出来也要把"试过什么"写清楚，
 * 否则用户唯一能做的就是再问一次。
 */

export function clock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '?';
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function linkLabel(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (/bilibili/i.test(u.hostname)) {
      const bv = /(BV[0-9A-Za-z]{10})/.exec(url);
      return bv ? bv[1] : u.hostname;
    }
    return u.hostname;
  } catch {
    return '';
  }
}

export function formatResult(result) {
  const video = result?.video ?? {};
  const heading = video.title ? `${video.title}${video.duration ? `（${clock(video.duration)}）` : ''}` : '这条视频';

  if (!result?.ok) {
    const tried = Array.isArray(result?.tried) ? result.tried : [];
    // 试过的位置可能很多（补扫 + 变调），只报前 8 个够定位问题了
    const marks = tried.map((t) => `${t.at === null || t.at === undefined ? '?' : clock(t.at)}${t.shift ? `×${t.shift}` : ''}`);
    const list = marks.slice(0, 8).join(' / ') + (marks.length > 8 ? ` …共 ${marks.length} 段` : '');
    const errors = tried.filter((t) => t.error).map((t) => `${t.at === null || t.at === undefined ? '?' : clock(t.at)}：${t.error}`);
    return [
      '❓ 没认出来',
      '',
      `- 视频：${heading}${video.url ? ` — ${video.url}` : ''}`,
      tried.length ? `- 已试：${list}（每段 ${result?.clipSeconds ?? 12} 秒，含原速与变调）` : '',
      '- 建议：用 at 参数指定更像有歌的时间点（秒），比如 at=75；或把 clipSeconds 调到 20 再试',
      errors.length ? `- 异常：${errors.slice(0, 3).join('；')}` : '',
      '- 注意：纯音乐、现场翻唱、太小声或混着人声的段落，Shazam 和网易云都可能认不出',
    ].filter(Boolean).join('\n');
  }

  const song = result.song ?? {};
  const title = song.title || '(未知曲名)';
  const artist = song.artist || '(未知歌手)';
  const lines = [
    `🎵 **${title}** — ${artist}`,
    '',
  ];
  if (song.album) lines.push(`- 专辑：${song.album}`);
  if (song.genre) lines.push(`- 流派：${song.genre}`);
  if (song.released) lines.push(`- 发行：${song.released}`);
  if (song.label) lines.push(`- 厂牌：${song.label}`);
  if (song.cover) lines.push(`- 封面：${song.cover}`);
  if (song.shazamUrl) lines.push(`- Shazam：${song.shazamUrl}`);
  const engineCount = Array.isArray(result.engines) ? result.engines.length : 2;
  const fixedEngineNote = engineCount === 1 ? '（设置页里固定只用这一个引擎）' : '';
  if (song.engine === 'netease') {
    lines.push(`- 引擎：网易云音乐（曲库里这一版是用户上传的 DJ 版/翻唱，跟原唱可能不同）${fixedEngineNote}`);
    if (song.url) lines.push(`- 网易云：${song.url}`);
  } else {
    lines.push(`- 引擎：Shazam（Apple Music 曲库）${fixedEngineNote}`);
  }
  const at = result.playedAt !== null && result.playedAt !== undefined
    ? clock(result.playedAt)
    : null;
  lines.push(`- 视频：${heading}${video.id ? ` [${linkLabel(video.url) || video.id}]` : ''}`);
  if (video.uploader) lines.push(`- 上传者：${video.uploader}`);
  if (at) lines.push(`- 命中位置：${at}（${result.clipSeconds ?? 12} 秒片段）`);
  if (result.shift && Math.abs(result.shift - 1) > 0.001) {
    lines.push(`- 变调：原速认不出，把片段升到 ×${result.shift} 才命中 —— 这条视频应该是降调/变速版，结论可能不准，建议核对`);
  }
  const matches = Array.isArray(result.matches) ? result.matches : [];
  // 两家引擎都指向同一首 → 基本可以信；只有一家认出来 → 提一句，别让用户白信
  const enginesOf = new Map();
  for (const m of matches) {
    const k = `${m.title || ''}|${m.artist || ''}`;
    const set = enginesOf.get(k) ?? new Set();
    set.add(m.engine ?? 'shazam');
    enginesOf.set(k, set);
  }
  const titleEngine = song.engine ?? 'shazam';
  const agreed = enginesOf.get(`${song.title || ''}|${song.artist || ''}`)?.size > 1;
  // 只有一个引擎在跑时（设置页固定了引擎），"另一家没认到"是理所当然的，别当噪音提醒
  const dualEngine = engineCount > 1;
  if (dualEngine && !agreed && titleEngine === 'netease' && matches.length) {
    lines.push('- 存疑：只有网易云认出来，Shazam 没认到同一首。串烧/翻唱视频里这是常态，建议对照着看一下');
  }
  if (matches.length > 1) {
    lines.push('', `- 这条视频里扫到 ${matches.length} 首不同的歌（像是串烧/混剪，位置不同歌就不同）：`);
    for (const m of matches.slice(0, 8)) {
      const stamp = m.at !== null && m.at !== undefined ? clock(m.at) : '?';
      const tail = [
        m.shift ? `×${m.shift} 变调` : '',
        m.engine === 'netease' ? '网易云' : '',
      ].filter(Boolean).join('，');
      lines.push(`  - ${stamp}：${m.title || '(未知曲名)'} — ${m.artist || '(未知歌手)'}${tail ? `（${tail}）` : ''}`);
    }
  }
  if (result.cached) lines.push('- 来源：缓存（7 天内问过同一条视频）');
  return lines.join('\n');
}
