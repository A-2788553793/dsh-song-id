/**
 * src/index.js — 插件入口，只做注册。
 *
 * 两条从别人插件的事故里学来的规矩，这里照抄：
 *  1. `inject` 只写 `['tools']`。cordis 的 inject 是硬前缀：服务没就绪 apply 就不跑，
 *     整个插件永远停在"加载中"，日志里什么都没有。
 *  2. `apply` 的异常一律吞掉并记录。最坏的结果是插件不能用，不是 DSH 起不来。
 *     要看真实错误就设 DSH_SONGID_DEBUG=1。
 */

import { formatResult } from './format.js';
import { identify } from './pipeline/identify.js';
import { songIdentifySpec } from './tool-spec.js';

export const name = 'dsh-song-id';
export const inject = ['tools'];

const APPLY_TIMEOUT_MS = 15_000;

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    try {
      ctx?.logger?.error?.(`[dsh-song-id] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    if (process.env.DSH_SONGID_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  // 注意：**不 import `@deepseek-ai/dsh-tools`**。装进 profile 之后那个包在 asar 里，
  // 从插件目录解析不到（这正是 dsh-qwen-paint 踩过的坑），于是整个 apply 会抛错、
  // 工具一个都注册不上。ctx.tools.register() 要的就是普通对象，output.schema 自己写成
  // 标准 JSON Schema 即可，defineTool 只是帮开发者补默认值，不是必需品。
  const tool = {
    ...songIdentifySpec(),
    async execute(args) {
      const result = await identify({
        url: args?.url,
        at: args?.at,
        clips: args?.clips,
        clipSeconds: args?.clipSeconds,
        cookies: args?.cookies,
        log: (message) => ctx?.logger?.debug?.(`[dsh-song-id] ${message}`),
      });
      return { text: formatResult(result) };
    },
  };

  const dispose = ctx.tools.register(tool);
  return () => dispose?.();
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
