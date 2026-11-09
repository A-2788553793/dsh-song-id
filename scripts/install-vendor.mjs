#!/usr/bin/env node
/**
 * scripts/install-vendor.mjs — 安装插件时顺手把 shazamio 装好。
 *
 * 设计成**永远 exit 0**：装依赖失败不该让插件装不上。
 * 真正的兜底在运行时（vendor.js 的 ensureVendor 懒装一次）。
 *
 * 加 --check 只检查不安装（给 CI / doctor 用）。
 */

import { ensureVendor, resolvePython, vendorDir } from '../src/pipeline/vendor.js';

const checkOnly = process.argv.includes('--check');

try {
  if (checkOnly) {
    const python = await resolvePython();
    const dir = vendorDir();
    console.log(`python: ${python}`);
    console.log(`vendor: ${dir}`);
  } else {
    const python = await resolvePython();
    const result = await ensureVendor({
      python,
      timeoutMs: 120_000,
      log: (message) => console.log(message),
    });
    console.log(result.installed ? `已安装 shazamio → ${result.dir}` : `shazamio 已就绪 → ${result.dir}`);
  }
} catch (e) {
  console.log(`跳过 shazamio 预装（${e?.message ?? e}）`);
  console.log('首次识曲时会再试一次；也可以手动跑：node scripts/install-vendor.mjs');
}
process.exit(0);
