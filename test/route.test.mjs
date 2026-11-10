/**
 * 设置端点的自检：没有宿主也能跑。
 * 重点看三件事：路由注册到哪儿、POST 真的落盘、非本机请求被挡。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { settingsFile } from '../src/pipeline/settings.js';

const plugin = await import('../src/index.js');

function makeCtx() {
  const routes = new Map();
  const ctx = {
    tools: { register: () => () => {} },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer']);
      callback({
        webServer: {
          register({ kind, path: routePath, handler }) {
            assert.equal(kind, 'exact');
            routes.set(routePath, handler);
            return () => routes.delete(routePath);
          },
        },
        effect(run) {
          return run();
        },
      });
    },
  };
  return { ctx, routes };
}

function makeRequest({ method = 'GET', body = null, host = '127.0.0.1:59786', remote = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/api/song-id/settings';
  req.headers = { host };
  req.socket = { remoteAddress: remote };
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  const res = {
    code: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(text) {
      this.body += text ?? '';
    },
  };
  return res;
}

test('注册了带 /api 的端点和不带 /api 的回退端点', async () => {
  const { ctx, routes } = makeCtx();
  await plugin.apply(ctx);
  assert.ok(routes.has('/api/song-id/settings'));
  assert.ok(routes.has('/song-id/settings'));
});

test('GET 读设置，POST 写设置', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-route-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const { ctx, routes } = makeCtx();
    await plugin.apply(ctx);
    const handler = routes.get('/api/song-id/settings');

    const readRes = makeResponse();
    await handler(makeRequest(), readRes);
    assert.equal(readRes.code, 200);
    assert.deepEqual(JSON.parse(readRes.body), { ok: true, engine: 'auto' });

    const writeRes = makeResponse();
    await handler(makeRequest({ method: 'POST', body: JSON.stringify({ engine: 'netease' }) }), writeRes);
    assert.deepEqual(JSON.parse(writeRes.body), { ok: true, engine: 'netease' });

    // 真的落盘了 —— 下次启动读的是同一个文件
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(settingsFile({ DSH_HOME: dir }), 'utf8'));
    assert.equal(saved.engine, 'netease');

    const afterRes = makeResponse();
    await handler(makeRequest(), afterRes);
    assert.deepEqual(JSON.parse(afterRes.body), { ok: true, engine: 'netease' });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST 非法引擎值被规范成 auto，而不是报错', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-route-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const { ctx, routes } = makeCtx();
    await plugin.apply(ctx);
    const handler = routes.get('/api/song-id/settings');
    const res = makeResponse();
    await handler(makeRequest({ method: 'POST', body: JSON.stringify({ engine: 'kugou' }) }), res);
    assert.deepEqual(JSON.parse(res.body), { ok: true, engine: 'auto' });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非本机请求一律 403', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'songid-route-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const { ctx, routes } = makeCtx();
    await plugin.apply(ctx);
    const handler = routes.get('/api/song-id/settings');
    const res = makeResponse();
    await handler(makeRequest({ remote: '192.168.1.9' }), res);
    assert.equal(res.code, 403);
    assert.equal(JSON.parse(res.body).ok, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
