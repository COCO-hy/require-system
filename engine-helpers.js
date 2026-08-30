#!/usr/bin/env node
/* ─────────────────────────────────────────────
   engine-helpers.js — DSH headless 引擎回写助手
   用法（cwd 须为 require-system）：
     node engine-helpers.js add-log <execId> <level> <message...>
     node engine-helpers.js update <execId> <status> [--result-file <json>] [--team-file <json>]
   ───────────────────────────────────────────── */
const fs = require('fs');
const [, , cmd, execId, ...rest] = process.argv;
const PORT = process.env.PORT || 3001;
const BASE = `http://localhost:${PORT}/api/requirements/executions`;

async function call(method, body) {
  const r = await fetch(`${BASE}/${execId}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

(async () => {
  if (!cmd || !execId) return console.log('usage: engine-helpers.js add-log <id> <level> <msg...> | update <id> <status> [--result-file f] [--team-file f]');

  if (cmd === 'add-log') {
    const level = rest[0] || 'info';
    const message = rest.slice(1).join(' ');
    const cur = await call('GET');
    const logs = Array.isArray(cur.data.logs) ? cur.data.logs : JSON.parse(cur.data.logs || '[]');
    logs.push({ level, message, timestamp: new Date().toISOString() });
    const r = await call('PUT', { logs });
    console.log(r.success ? `LOG-ADDED:${execId}` : `FAILED:${JSON.stringify(r)}`);
  } else if (cmd === 'update') {
    const status = rest[0];
    if (!status) return console.log('usage: update <id> <status> [--result-file f] [--team-file f]');
    const body = { status };
    const rf = rest.indexOf('--result-file'), tf = rest.indexOf('--team-file');
    if (rf >= 0 && rest[rf + 1]) body.result_data = JSON.parse(fs.readFileSync(rest[rf + 1], 'utf-8'));
    if (tf >= 0 && rest[tf + 1]) body.agent_teams_data = JSON.parse(fs.readFileSync(rest[tf + 1], 'utf-8'));
    const r = await call('PUT', body);
    console.log(r.success ? `UPDATED:${execId}:${status}` : `FAILED:${JSON.stringify(r)}`);
  } else {
    console.log('unknown cmd:', cmd);
  }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
