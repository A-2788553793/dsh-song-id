/**
 * src/index.js — 插件入口：注册识曲工具 + 设置页需要的读写端点。
 *
 * 两条从别人插件的事故里学来的规矩，这里照抄：
 *  1. `inject` 只写 `['tools']`。cordis 的 inject 是硬前缀：服务没就绪 apply 就不跑，
 *     整个插件永远停在"加载中"，日志里什么都没有。webServer 是可选的，用局部 inject。
 *  2. `apply` 的异常一律吞掉并记录。最坏的结果是插件不能用，不是 DSH 起不来。
 *     要看真实错误就设 DSH_SONGID_DEBUG=1。
 */

import { formatResult } from './format.js';
import { identify } from './pipeline/identify.js';
import { normalizeEngine, readSettings, writeSettings } from './pipeline/settings.js';
import { songIdentifySpec } from './tool-spec.js';

export const name = 'dsh-song-id';
export const inject = ['tools'];

const APPLY_TIMEOUT_MS = 15_000;

/** 设置页读写端点。带 /api/ 的那条给页面用；不带的那条留作回退与手工 curl。 */
const SETTINGS_PATHS = ['/api/song-id/settings', '/song-id/settings'];

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    try {
      ctx?.logger?.error?.(`[dsh-song-id] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const base = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
      const logDir = path.join(base, 'storages', 'song-id');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'load-error.log'), new Date().toISOString() + '\n' + (e?.stack ?? String(e)) + '\n');
    } catch { /* 记不下来也只能算了 */ }
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
      // 引擎偏好在设置页里选（自动 / 只 Shazam / 只网易云），每次执行现读，
      // 用户改完设置不必重启 DSH。
      const settings = readSettings(process.env);
      const result = await identify({
        url: args?.url,
        at: args?.at,
        clips: args?.clips,
        clipSeconds: args?.clipSeconds,
        cookies: args?.cookies,
        engine: normalizeEngine(args?.engine ?? settings.engine),
        log: (message) => ctx?.logger?.debug?.(`[dsh-song-id] ${message}`),
      });
      return { text: formatResult(result) };
    },
  };

  const disposeTool = ctx.tools.register(tool);
  const disposeRoutes = registerSettingsRoute(ctx);
  return () => {
    try { disposeTool?.(); } catch { /* 卸载时出错不影响其它插件 */ }
    try { disposeRoutes?.(); } catch { /* 同上 */ }
  };
}

/**
 * 设置页的 HTTP 端点。客户端那一半在浏览器里，没有文件系统，也拿不到宿主服务，
 * 所以走和 dsh-qwen-paint 一样的路子：host 起一个只放行本机请求的小路由。
 */
function registerSettingsRoute(ctx) {
  if (typeof ctx?.inject !== 'function') return () => {};
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const handler = async (req, res) => {
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403);
          return;
        }
        try {
          if (String(req?.method ?? 'GET').toUpperCase() === 'POST') {
            const body = await readJsonBody(req);
            if (body === null || typeof body !== 'object') {
              respondJson(res, { ok: false, reason: 'body must be a JSON object' }, 400);
              return;
            }
            // 只认 engine 一个字段，且过白名单 —— 这个端点不碰路径、不执行命令
            const next = writeSettings(process.env, { engine: normalizeEngine(body.engine) });
            try { ctx?.logger?.info?.(`[dsh-song-id] 引擎偏好已改为 ${next.engine}`); } catch { /* 日志失败无所谓 */ }
            respondJson(res, { ok: true, ...next });
            return;
          }
          respondJson(res, { ok: true, ...readSettings(process.env) });
        } catch (error) {
          respondJson(res, { ok: false, reason: String(error?.message ?? error) });
        }
      };

      try {
        webCtx.effect(() => {
          const disposers = SETTINGS_PATHS.map((path) => webCtx.webServer.register({ kind: 'exact', path, handler }));
          return () => {
            for (const dispose of disposers) {
              try { dispose(); } catch { /* 已经没了 */ }
            }
          };
        }, 'dsh-song-id:settings-route');
      } catch (error) {
        try {
          ctx?.logger?.warn?.(`[dsh-song-id] 注册设置端点失败（不影响识曲）：${error?.message ?? error}`);
        } catch { /* 同上 */ }
      }
    });
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`[dsh-song-id] 没有 webServer，跳过设置端点：${error?.message ?? error}`);
    } catch { /* 同上 */ }
  }
  return () => {};
}

/* ---------------------------------------------------------------- 小工具 ---- */

/** 只放行本机来的请求：这个端点会写盘，不能对局域网开放。 */
function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase();
  const remote = String(req?.socket?.remoteAddress ?? '');
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host);
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return hostOk && remoteOk;
}

/** 回 JSON；任何异常都降级成一个可读的错误体，绝不 5xx。 */
function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }));
    } catch { /* 连接已经没了 */ }
  }
}

/** 读请求体（设置只有一个字段，64KB 足够；超了就当空）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req?.on?.('data', (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    req?.on?.('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req?.on?.('error', () => finish(null));
    // 客户端半路断开时 on('end') 不会来，别把 handler 挂死
    req?.on?.('close', () => finish(null));
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
