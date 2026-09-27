/**
 * DeepSeek 峰谷时段 + 官方价 —— 单一真相来源（CommonJS，零依赖）
 *
 * 官方: https://api-docs.deepseek.com/zh-cn/quick_start/pricing （中文页直接给人民币价）
 *   高峰 = 北京时间 周一至周五（不含中国法定节假日）09:00-12:00 与 14:00-18:00
 *   空闲 = 其余全部时间（含周末与法定节假日全天）；空闲价 = 高峰价的一半
 *   （英文页把同一规则写成 UTC 01:00-04:00 / 06:00-10:00）
 *
 * 消费方：scripts/statusline.mjs（状态栏段）、scripts/ds-usage.cjs（计费）、scripts/ds.js（CLI）
 * 改价 / 补节假日表 → 只改本文件顶部的 RATES 与 HOLIDAY_RANGES。
 */
'use strict';

const M = 60e3, H = 60 * M, D = 24 * H;
const CN_OFFSET = 8 * H; // 北京时间 = UTC+8，无夏令时

// ── 中国法定节假日（北京时间日期）──
// 来源: 《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，2025-11-04）
// 每年 11 月国务院公布次年安排后补表；缺表的年份峰谷只按"周末 + 时段"判定，结果会带 ?
const HOLIDAY_RANGES = {
  2026: [
    ['2026-01-01', '2026-01-03'], // 元旦 3 天
    ['2026-02-15', '2026-02-23'], // 春节 9 天
    ['2026-04-04', '2026-04-06'], // 清明 3 天
    ['2026-05-01', '2026-05-05'], // 劳动节 5 天
    ['2026-06-19', '2026-06-21'], // 端午 3 天
    ['2026-09-25', '2026-09-27'], // 中秋 3 天
    ['2026-10-01', '2026-10-07'], // 国庆 7 天
  ],
};

function expandRanges(ranges) {
  const out = [];
  for (const [from, to] of ranges) {
    const [y1, m1, d1] = from.split('-').map(Number);
    const [y2, m2, d2] = to.split('-').map(Number);
    for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += D) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  return out;
}

const HOLIDAYS = Object.fromEntries(
  Object.entries(HOLIDAY_RANGES).map(([year, ranges]) => [Number(year), expandRanges(ranges)]),
);
const HOLIDAY_SET = new Set(Object.values(HOLIDAYS).flat());
const HOLIDAY_YEARS = new Set(Object.keys(HOLIDAYS).map(Number));

// ── 官方价（元 / 百万 tokens），顺序恒为 [高峰, 空闲] ──
// deepseek-flash  : 缓存命中 0.04/0.02 · 缓存未命中 2/1 · 输出 8/4
// deepseek-v4-pro : 缓存命中 0.30/0.15 · 缓存未命中 9/4.5 · 输出 27/13.5
const RATES = {
  flash: { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  pro: { hit: [0.30, 0.15], miss: [9, 4.5], out: [27, 13.5] },
};
const MODEL_LABEL = { flash: 'deepseek-flash', pro: 'deepseek-v4-pro' };

/** 从模型 id / 显示名挑价目表：认 v4-pro / pro，其余（含 deepseek-flash）按 flash */
function pickModel(modelId) {
  return /v4[-\s]?pro|deepseek-pro/i.test(String(modelId || '')) ? 'pro' : 'flash';
}

const pad = (n) => String(n).padStart(2, '0');
const toMs = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

/** 北京时间的日历字段 */
function bjFields(t) {
  const d = new Date(toMs(t) + CN_OFFSET);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), sec: d.getUTCSeconds(), wd: d.getUTCDay(),
  };
}
const bjDate = (f) => `${f.y}-${pad(f.mo)}-${pad(f.d)}`;
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PEAK_WINDOWS = [[9, 12], [14, 18]]; // 北京时，左闭右开

/** 是否高峰（true=高峰，false=空闲） */
function isPeak(t) {
  const f = bjFields(t);
  if (f.wd === 0 || f.wd === 6) return false;            // 周末整日空闲
  if (HOLIDAY_SET.has(bjDate(f))) return false;          // 法定节假日整日空闲
  return PEAK_WINDOWS.some(([a, b]) => f.h >= a && f.h < b);
}

/** 该时刻所在年份有没有节假日表（没有则峰谷结果存疑） */
function hasHolidayData(t) {
  return HOLIDAY_YEARS.has(bjFields(t).y);
}

/** 下一次峰谷切换；ok=false 表示扫描区间内有年份缺节假日表 */
function nextChange(now) {
  const start = now === undefined ? Date.now() : toMs(now);
  const cur = isPeak(start);
  const limit = start + 15 * D; // 最长空档：国庆/春节前后可到 8 天以上
  let t = Math.ceil(start / M) * M;
  let ok = true;
  while (t <= limit) {
    if (!HOLIDAY_YEARS.has(bjFields(t).y)) ok = false;
    if (isPeak(t) !== cur) return { t, ok, peak: !cur };
    t += M;
  }
  return { t: null, ok, peak: !cur };
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / M));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${mi}m`;
  return `${mi}m`;
}

/** 秒级时长：7d15h02m11s / 15h51m23s / 9m05s / 42s */
function fmtDurSec(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p2 = (n) => String(n).padStart(2, '0');
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d) return `${d}d${p2(h)}h${p2(m)}m${p2(s)}s`;
  if (h) return `${h}h${p2(m)}m${p2(s)}s`;
  if (m) return `${m}m${p2(s)}s`;
  return `${s}s`;
}

/** 北京时间 24 小时制时钟 HH:MM:SS（DeepSeek 的计费窗口按北京时算） */
function bjClock(now) {
  const f = bjFields(now === undefined ? Date.now() : now);
  return `${pad(f.h)}:${pad(f.mi)}:${pad(f.sec)}`;
}

/**
 * 峰谷徽标：`🔴DS峰 3h00m12s` / `🟢DS谷 3h00m12s`，英文 `🔴DS peak 3h00m12s` / `🟢DS off 3h00m12s`
 * 缺节假日表的年份带 ?。lang 由配置语言决定（'zh*' → 中文，其余英文）。
 */
function peakBadge(now, lang) {
  const t = now === undefined ? Date.now() : toMs(now);
  const peak = isPeak(t);
  const { t: next, ok } = nextChange(t);
  const dur = next ? fmtDurSec(next - t) : '?';
  const mark = peak ? '🔴' : '🟢';
  const zh = String(lang || '').toLowerCase().startsWith('zh');
  const state = zh ? (peak ? '峰' : '谷') : (peak ? 'peak' : 'off');
  return `${mark}DS${zh ? '' : ' '}${state}${ok ? '' : '?'} ${dur}`;
}

const emptyBucket = () => ({ inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 });

/**
 * 按官方口径算钱：输入分"缓存命中/未命中"两档，再乘该消息所属时段的价。
 *   - inputTokens 是 Anthropic 语义的 input_tokens（不含缓存读写，实测互斥）
 *   - cacheCreationTokens 与 inputTokens 同为"未命中"；cacheReadTokens 走命中价
 * periodIndex: 0 = 高峰，1 = 空闲
 */
function costFromBucket(bucket, modelKey, periodIndex) {
  if (!bucket) return 0;
  const r = RATES[modelKey] || RATES.flash;
  const miss = (bucket.inputTokens + bucket.cacheCreationTokens) / 1e6 * r.miss[periodIndex];
  const hit = bucket.cacheReadTokens / 1e6 * r.hit[periodIndex];
  const out = bucket.outputTokens / 1e6 * r.out[periodIndex];
  return miss + hit + out;
}

/** 峰谷两个桶合计 */
function costFromBuckets(buckets, modelKey, now) {
  if (!buckets || (!buckets.peak && !buckets.offPeak)) return null;
  const idx = isPeak(now === undefined ? Date.now() : now) ? 0 : 1;
  const hasPeak = buckets.peak !== undefined;
  const hasOff = buckets.offPeak !== undefined;
  return {
    total: (hasPeak ? costFromBucket(buckets.peak, modelKey, 0) : 0) + (hasOff ? costFromBucket(buckets.offPeak, modelKey, 1) : 0),
    peak: costFromBucket(buckets.peak, modelKey, 0),
    offPeak: costFromBucket(buckets.offPeak, modelKey, 1),
    currentIndex: idx,
  };
}

module.exports = {
  M, H, D, CN_OFFSET,
  HOLIDAY_RANGES, HOLIDAYS, HOLIDAY_SET, HOLIDAY_YEARS,
  RATES, MODEL_LABEL, PEAK_WINDOWS, WD,
  pickModel, bjFields, bjDate, isPeak, hasHolidayData, nextChange,
  fmtDur, fmtDurSec, bjClock, peakBadge,
  emptyBucket, costFromBucket, costFromBuckets,
};
