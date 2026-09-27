#!/usr/bin/env node
/**
 * 后台抓一次余额，写进 cache/balance.json。由 scripts/ds-usage.cjs 以 detached 方式拉起，
 * 自己绝不参与状态栏渲染 —— 状态栏那 1 秒一次的 tick 不该等一个网络请求。
 *
 * 手动跑也行：node scripts/fetch-balance.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DS = require(join(HERE, 'ds-usage.cjs'));

const bal = await DS.fetchBalance(5000);
const file = join(DS.CACHE_DIR, 'balance.json');
try {
  mkdirSync(DS.CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(bal ?? { error: true, at: Date.now() }));
} catch { /* ignore */ }
process.exit(0);
