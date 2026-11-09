import assert from 'node:assert/strict';
import test from 'node:test';

import { bvOf, cacheKey, normalizeUrl } from '../src/pipeline/url.js';

test('BV 号补成完整链接', () => {
  assert.equal(normalizeUrl('BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('av 号补成完整链接', () => {
  assert.equal(normalizeUrl('av170001'), 'https://www.bilibili.com/video/av170001');
});

test('完整链接原样保留（包括 query）', () => {
  const url = 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.1007&p=2';
  assert.equal(normalizeUrl(url), url);
});

test('裸域名补 https', () => {
  assert.equal(normalizeUrl('b23.tv/abc123'), 'https://b23.tv/abc123');
  assert.equal(normalizeUrl('youtu.be/xyz'), 'https://youtu.be/xyz');
});

test('空输入与垃圾输入明确报错', () => {
  assert.throws(() => normalizeUrl(''), /url 不能为空/);
  assert.throws(() => normalizeUrl('随便一句话'), /不认识的输入/);
});

test('cacheKey 吃 BV 号，忽略跟踪参数差异', () => {
  const a = cacheKey('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=1');
  const b = cacheKey('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(a, 'bilibili:BV1xx411c7mD');
  assert.equal(a, b);
});

test('cacheKey 区分分 P', () => {
  assert.equal(
    cacheKey('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=x'),
    'bilibili:BV1xx411c7mD:p2',
  );
});

test('cacheKey 对非 B 站链接去掉跟踪参数', () => {
  const key = cacheKey('https://youtu.be/xyz?si=abc&feature=share&t=30');
  assert.equal(key, 'https://youtu.be/xyz');
});

test('bvOf 抽不到就是 null', () => {
  assert.equal(bvOf('https://www.bilibili.com/video/BV1xx411c7mD'), 'BV1xx411c7mD');
  assert.equal(bvOf('https://example.com/x'), null);
});
