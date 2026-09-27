#!/usr/bin/env node
/**
 * 造一份假的 statusLine stdin 载荷，用来离线试状态栏（不必真开一个 Claude Code 会话）。
 *
 *   node tools/make-sample-stdin.mjs > /tmp/stdin.json
 *   node scripts/statusline.mjs < /tmp/stdin.json
 *   node tools/make-sample-stdin.mjs --cwd "AA/BB/CC" --model deepseek-v4-pro
 *
 * 字段取的是 Claude Code 真实传给 statusLine 的那一份（2.1.283）。transcript_path 默认指向
 * 本机最新的会话转录（这样费用/峰谷能算出真数），可用 --transcript <path> 指定。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const home = homedir();
const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');

function newestTranscript() {
  let newest = null;
  let newestTime = 0;
  try {
    const projects = join(claudeDir, 'projects');
    for (const sub of readdirSync(projects)) {
      const subDir = join(projects, sub);
      if (!statSync(subDir).isDirectory()) continue;
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = join(subDir, f);
        const st = statSync(fp);
        if (st.mtimeMs > newestTime) { newestTime = st.mtimeMs; newest = fp; }
      }
    }
  } catch { /* ignore */ }
  return newest;
}

const transcript = arg('transcript', newestTranscript() ?? join(claudeDir, 'projects', 'demo', 'demo.jsonl'));
const cwd = arg('cwd', process.cwd());
const model = arg('model', 'deepseek-flash[1m]');

const payload = {
  hook_event_name: 'Status',
  session_id: arg('session', 'sample-session-0000'),
  transcript_path: transcript,
  cwd,
  model: { id: model, display_name: model.replace(/\[.*$/, '') },
  workspace: { current_dir: cwd, project_dir: cwd },
  version: '2.1.283',
  output_style: { name: 'default' },
  context_window: {
    total_input_tokens: Number(arg('tokens', '42000')),
    context_window_size: Number(arg('window', '1000000')),
    current_usage: { input_tokens: 12000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000 },
  },
  cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
};

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
