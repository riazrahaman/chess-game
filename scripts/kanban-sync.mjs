#!/usr/bin/env node
// Sync docs/kanban-tasks.json to an agent-kanban-board instance. Idempotent:
// creates missing cards (with their target status), reconciles status /
// priority / description / depends_on on existing ones, and appends one log
// line per change. Never deletes.
//
//   KANBAN_URL=https://… KANBAN_AUTH_TOKEN=<token> node scripts/kanban-sync.mjs [--dry-run] [--manifest path]
//
// The token is the value for this project in the board's KANBAN_PROJECT_TOKENS
// map (or the global KANBAN_AUTH_TOKEN). It is read from the environment only.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const manifestPath = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : path.resolve('docs/kanban-tasks.json');
const BASE = (process.env.KANBAN_URL || 'https://agent-kanban-board-production.up.railway.app').replace(/\/+$/, '');
const TOKEN = process.env.KANBAN_AUTH_TOKEN;
const AGENT = process.env.KANBAN_AGENT_ID || 'claude-code-lead';

if (!TOKEN && !dryRun) {
  console.error('KANBAN_AUTH_TOKEN is not set (read from the environment only; never commit it).');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const project = manifest.project;
if (!project) throw new Error('manifest.project is required');

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN || ''}`,
  'X-Agent-Id': AGENT,
  'X-Agent-Role': 'human', // may administer any transition (board role rules)
  'X-Kanban-Project': project
};

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

function sameList(a, b) {
  const x = Array.isArray(a) ? [...a].sort() : [];
  const y = Array.isArray(b) ? [...b].sort() : [];
  return JSON.stringify(x) === JSON.stringify(y);
}

const existing = await api('GET', `/api/tasks?project=${encodeURIComponent(project)}`);
if (existing.status !== 200 || !Array.isArray(existing.json)) {
  console.error(`Cannot list tasks: HTTP ${existing.status}`, existing.json);
  process.exit(1);
}
const byId = new Map(existing.json.map(t => [t.id, t]));
console.log(`${BASE} project=${project}: ${byId.size} existing card(s); manifest has ${manifest.tasks.length}${dryRun ? ' (dry run)' : ''}`);

let created = 0, updated = 0, unchanged = 0, failed = 0;
for (const t of manifest.tasks) {
  const cur = byId.get(t.id);
  if (!cur) {
    const body = {
      id: t.id, project, title: t.title, description: t.description || '', status: t.status || 'BACKLOG',
      priority: t.priority || 'medium', round: t.round || 1, depends_on: t.depends_on || [],
      branch: t.branch || `task/${t.id}`, metadata: { source: 'docs/kanban-tasks.json' }
    };
    if (dryRun) { console.log(`  + would create ${t.id} [${body.status}] ${t.title}`); created++; continue; }
    const r = await api('POST', `/api/tasks?project=${encodeURIComponent(project)}`, body);
    if (r.status === 201) {
      created++;
      console.log(`  + created ${t.id} [${body.status}]`);
      await api('POST', `/api/tasks/${encodeURIComponent(t.id)}/logs?project=${encodeURIComponent(project)}`, { message: `imported from docs/kanban-tasks.json (round ${body.round})`, agent_id: AGENT });
    } else {
      failed++;
      console.log(`  ! create ${t.id} failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    }
    continue;
  }

  const patch = {};
  if (t.status && cur.status !== t.status) patch.status = t.status;
  if (t.priority && cur.priority !== t.priority) patch.priority = t.priority;
  if (t.description !== undefined && (cur.description || '') !== t.description) patch.description = t.description;
  if (t.depends_on && !sameList(cur.depends_on, t.depends_on)) patch.depends_on = t.depends_on;
  if (Object.keys(patch).length === 0) { unchanged++; continue; }
  if (dryRun) { console.log(`  ~ would update ${t.id}: ${Object.keys(patch).join(', ')}`); updated++; continue; }
  const r = await api('PATCH', `/api/tasks/${encodeURIComponent(t.id)}?project=${encodeURIComponent(project)}`, patch);
  if (r.status === 200) {
    updated++;
    console.log(`  ~ updated ${t.id}: ${Object.keys(patch).join(', ')}`);
    if (patch.status) await api('POST', `/api/tasks/${encodeURIComponent(t.id)}/logs?project=${encodeURIComponent(project)}`, { message: `status -> ${patch.status} (kanban-sync)`, agent_id: AGENT });
  } else {
    failed++;
    console.log(`  ! update ${t.id} failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
}

console.log(`\ncreated ${created}, updated ${updated}, unchanged ${unchanged}, failed ${failed}`);
process.exit(failed ? 1 : 0);
