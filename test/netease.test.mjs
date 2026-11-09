import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNeteasePayload } from '../src/pipeline/netease.js';

test('parseNeteasePayload 把网易云结果压成统一的小对象', () => {
  const json = {
    code: 200,
    data: {
      type: 1,
      result: [
        {
          startTime: 362140,
          song: {
            id: 1234567890,
            name: '示例歌名',
            artists: [{ name: '歌手甲' }, { name: '歌手乙' }],
            album: { name: '示例专辑', picUrl: 'http://p1.music.126.net/a.jpg' },
          },
        },
      ],
    },
  };
  const out = parseNeteasePayload(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '示例歌名');
  assert.equal(out[0].artist, '歌手甲 / 歌手乙');
  assert.equal(out[0].album, '示例专辑');
  assert.equal(out[0].cover, 'http://p1.music.126.net/a.jpg');
  assert.equal(out[0].url, 'https://music.163.com/song?id=1234567890');
  assert.equal(out[0].engine, 'netease');
});

test('parseNeteasePayload 对未命中 / 脏数据不炸', () => {
  assert.deepEqual(parseNeteasePayload({ code: 200, data: { result: null, noMatchReason: 10 } }), []);
  assert.deepEqual(parseNeteasePayload({}), []);
  assert.deepEqual(parseNeteasePayload(null), []);

  const dirty = parseNeteasePayload({
    data: { result: [{ song: {} }, { song: { name: '只有歌名' } }] },
  });
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].title, '只有歌名');
  assert.equal(dirty[0].artist, '');
  assert.equal(dirty[0].url, '');
});
