/**
 * pipeline/vendor.js — Python 与 shazamio 的落地。
 *
 * 铁律：**不碰全局 Python 环境**。shazamio 装进包自己的 `vendor/py`，
 * 运行时靠 PYTHONPATH 注入。用户卸载插件 = 删目录，系统里不留痕迹。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ytdlp.js';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function vendorDir(env = process.env) {
  return env.DSH_SONGID_VENDOR || path.join(PACKAGE_ROOT, 'vendor', 'py');
}

/**
 * 找 python 的候选路径。
 *
 * **要在 PATH 上直接 spawn 真解释器，不能 spawn `python.cmd` 这种包装脚本** ——
 * Node 在 Windows 上不走 shell，.cmd 一律 ENOENT（实测 status 9009）。
 * 而这台机器上 `python` 恰恰就是 C:\Users\a\.dsh\bin\python.cmd 这种 shim，
 * 所以必须：① 先找真 .exe；② 实在只有 .cmd，就把它里面写死的 python.exe 抠出来。
 */
export function pythonCandidates(env = process.env) {
  const out = [];
  if (env.DSH_PYTHON_PATH) out.push(env.DSH_PYTHON_PATH);

  const exeNames = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
  const shimNames = process.platform === 'win32' ? ['python.cmd', 'python.bat', 'python3.cmd'] : [];

  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of exeNames) out.push(path.join(dir, name));
  }
  for (const dir of pathDirs) {
    for (const name of shimNames) out.push(path.join(dir, name)); // 后面会被解析成真 exe
  }

  // DSH 自己的 venv（真实机器上 python.cmd 指的就是这里）
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const venvs = path.join(dshHome, 'venvs');
  try {
    for (const name of readdirSync(venvs)) {
      out.push(path.join(venvs, name, 'Scripts', 'python.exe'));
      out.push(path.join(venvs, name, 'bin', 'python3'));
    }
  } catch { /* 没有 venvs 目录 */ }

  if (env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'Programs', 'Python');
    try {
      for (const d of readdirSync(root)) out.push(path.join(root, d, 'python.exe'));
    } catch { /* ignore */ }
  }
  if (env.APPDATA) {
    const root = path.join(env.APPDATA, 'Python');
    try {
      for (const d of readdirSync(root)) out.push(path.join(root, d, 'python.exe'));
    } catch { /* ignore */ }
  }

  return [...new Set(out)];
}

/** 从 .cmd/.bat shim 里抠出它真正调用的解释器路径。 */
function resolveShim(candidate) {
  if (!/\.(cmd|bat)$/i.test(candidate)) return null;
  try {
    const text = readFileSync(candidate, 'utf8');
    const m = /["']([^"']*python[^"']*\.exe)["']/i.exec(text)
      || /\b([A-Za-z]:\\[^\s"']*python[^"']*\.exe)\b/i.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 找到一个能跑的 Python。DSH_PYTHON_PATH 最优先（用户明确指定的必须赢）。 */
export async function resolvePython(env = process.env) {
  const seen = new Set();
  for (const candidate of pythonCandidates(env)) {
    const real = /\.(cmd|bat)$/i.test(candidate) ? resolveShim(candidate) : candidate;
    if (!real || seen.has(real)) continue;
    seen.add(real);
    try {
      if (!existsSync(real)) continue;
    } catch {
      continue;
    }
    try {
      const { code } = await runProcess(real, ['-c', 'import sys;sys.exit(0 if sys.version_info>=(3,9) else 1)'], {
        timeoutMs: 20_000,
      });
      if (code === 0) return real;
    } catch { /* 下一个 */ }
  }
  throw new Error(
    '没找到可用的 Python 3.9+（识曲引擎 shazamio 跑在 Python 上）。\n'
    + '装一个 python 并放进 PATH，或用 DSH_PYTHON_PATH 指给我（要给 .exe，不要 .cmd 包装脚本）。',
  );
}

async function canImportShazamio(python, dir) {
  try {
    const { code } = await runProcess(python, ['-c', 'import shazamio'], {
      env: { ...process.env, PYTHONPATH: dir },
      timeoutMs: 40_000,
    });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * 确保 shazamio 可用；缺了就装一次。
 * @returns {Promise<{ok:true, dir:string, installed:boolean}>}
 */
export async function ensureVendor({ python, timeoutMs = 300_000, log } = {}) {
  const dir = vendorDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (await canImportShazamio(python, dir)) return { ok: true, dir, installed: false };

  log?.('首次使用：正在安装识曲依赖 shazamio（一次性，装到插件自己的 vendor 目录）…');
  const { stderr, stdout, code } = await runProcess(
    python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '--target', dir, 'shazamio'],
    { timeoutMs },
  );
  if (code !== 0) {
    const tail = String(stderr || stdout || '').trim().split(/\r?\n/).slice(-4).join('\n');
    throw new Error(`装 shazamio 失败：\n${tail}\n\n可以手动跑：\n  ${python} -m pip install --target "${dir}" shazamio`);
  }
  if (!(await canImportShazamio(python, dir))) {
    throw new Error(`shazamio 装到了 ${dir} 但 import 不成功（可能 python 版本太低）。`);
  }
  return { ok: true, dir, installed: true };
}
