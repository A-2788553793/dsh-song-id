/**
 * src/tool-spec.js — `song_identify` 的契约。
 *
 * 宿主只认 schema 里声明过的参数（没声明的会被直接丢掉），
 * 所以这里列出来的每一项，handler 都必须实打实地用到。
 */

export const TOOL_NAME = 'song_identify';

export function songIdentifySpec() {
  return {
    name: TOOL_NAME,
    description: [
      'Identify the song playing in a video: give it a Bilibili link (or BV id, b23.tv short link,',
      'YouTube link, and anything else yt-dlp handles) and it extracts the audio with yt-dlp + ffmpeg,',
      'then asks two engines in parallel — Shazam (via shazamio) and NetEase Cloud Music — and merges',
      'their answers. NetEase is there because its catalogue is user-uploaded and full of DJ / cover /',
      'AI versions that Shazam only knows as the original.',
      '',
      'Returns: title, artist, album, genre, release date, cover art, which engine answered, the timestamp',
      'where the song was detected, and the video metadata. By default it samples three 12-second clips at',
      '12% / 42% / 72% of the video; if nothing matches it scans 7 more positions and then retries with',
      'pitched-up copies (x1.06 / x1.12), because Bilibili is full of "降调 0.95x" uploads that Shazam',
      'cannot fingerprint at the original pitch.',
      '',
      'Costs a few seconds for a normal MV (up to ~2 minutes for a DJ mashup); results are cached for 7',
      'days per video. If nothing matches, try `at` (a moment you are sure the song is playing) or a',
      'longer `clipSeconds`.',
      '',
      '中文触发场景：听歌识曲、这视频里是什么歌、B 站视频 BGM 是什么、识别背景音乐。',
    ].join('\n'),
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Video link, BV id (BV1xx411c7mD), b23.tv short link, or any yt-dlp-supported URL.',
      },
      at: {
        type: 'number',
        description: 'Start recognition at this many seconds (0-based). Use when you know where the song is.',
      },
      clips: {
        type: 'number',
        description: 'How many clips to try (1-5, default 3). More clips = more chance, slower.',
      },
      clipSeconds: {
        type: 'number',
        description: 'Length of each clip in seconds (5-30, default 12). Longer helps with quiet intros.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a cookies.txt for login-gated videos (else DSH_VIDEO_COOKIES).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Markdown: song, artist, album, cover, timestamp.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe() {
      return true;
    },
  };
}
