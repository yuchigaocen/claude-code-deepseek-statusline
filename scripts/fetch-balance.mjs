#!/usr/bin/env node
/**
 * 后台抓一次余额，把**结果**写进 cache/balance.json —— 成功写值，失败写原因。
 *
 * 失败也一定要写：里面那个 retryAt 是渲染端停止空转的依据（旧的写法只写 {error:true}，
 * 结果渲染端读不出来，于是一把错误的 key 会每 15 秒重试一次，永远）。
 *
 * 由 scripts/ds-usage.cjs 以 detached 方式拉起，自己绝不参与状态栏渲染 ——
 * 状态栏那 1 秒一次的 tick 不该等一个网络请求。
 *
 * 手动跑也行：node scripts/fetch-balance.mjs
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DS = require(join(HERE, 'ds-usage.cjs'));

const rec = await DS.fetchBalance(5000);
try {
  mkdirSync(DS.CACHE_DIR, { recursive: true });
  DS.writeBalanceRecord(rec, join(DS.CACHE_DIR, 'balance.json'));
} catch { /* ignore */ }
process.exit(0);
