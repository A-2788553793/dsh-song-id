/**
 * 注册链路的自检：没有宿主也能跑。
 * 盯的是三件事：inject 只有 tools / apply 不抛 / 注册出来的 spec 形状对。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const plugin = await import('../src/index.js');

test('插件名与 inject', () => {
  assert.equal(plugin.name, 'dsh-song-id');
  assert.deepEqual(plugin.inject, ['tools']);
});

test('apply 注册 song_identify，并返回 disposer', async () => {
  const registered = [];
  let disposed = false;
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => { disposed = true; }; } },
    logger: { error() {}, debug() {} },
  };

  const dispose = await plugin.apply(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.length, 1);

  const tool = registered[0];
  assert.equal(tool.name, 'song_identify');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.parameters.url.required, true);
  assert.equal(tool.parameters.url.type, 'string');
  assert.equal(tool.parameters.at.type, 'number');
  assert.equal(tool.parameters.clips.type, 'number');
  assert.equal(tool.parameters.clipSeconds.type, 'number');
  assert.equal(tool.parameters.cookies.type, 'string');
  assert.deepEqual(Object.keys(tool.output.schema.properties), ['text']);
  assert.equal(tool.output.schema.properties.text.type, 'string');
  assert.deepEqual(tool.output.schema.required, ['text']);
  assert.equal(tool.output.schema.properties.text.required, undefined);
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
  assert.equal(typeof tool.timeoutMs, 'number');
  assert.equal(tool.isConcurrencySafe(), true);

  dispose();
  assert.equal(disposed, true);
});

test('apply 不依赖 @deepseek-ai/dsh-tools（装进 profile 后也解析不到它）', async () => {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } }, logger: { error() {}, debug() {} } };
  const dispose = await plugin.apply(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'song_identify');
});
