import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roadmap = fs.readFileSync(new URL('../docs/06-world-class-roadmap.md', import.meta.url), 'utf8');

const titles = {
  13: 'AccountsManager JSON fallback cross-contamination on Node < 22.5',
  14: 'Sign-in dialog rendered bottom-left with no backdrop (missing #auth-modal rule)',
  15: 'Missed-tactics analysis was unbounded (serial engine searches per request)',
  16: 'The Playwright browser journeys never ran in CI',
  17: 'The game-archive JSON fallback never ran on a sqlite-capable Node in CI',
  18: 'CI browser job flaked on Study chapter creation (stale list response)',
  19: 'CI browser job flaked on the seat badge (fixed sleep racing the seat swap)',
  20: 'Undo-request browser block flaked on a fixed sleep; failure path leaked its server',
  21: 'Bot-config race left the human on the wrong seat under load (uncancelled stale POST)',
  22: 'History-Scrubbing browser block flaked on a fixed sleep racing the client state sync',
  23: 'Stale browser premove in the scrub block + uncancelled bot timer in production',
};

const labels = {
  19: ['bug', 'resolved'], 20: ['bug', 'resolved'], 21: ['bug', 'resolved'],
  22: ['bug', 'resolved'], 23: ['bug', 'resolved'],
};

const clean = s => s.replace(/\\\|/g, '|').replace(/\\`/g, '`');

const nums = process.argv.slice(2).map(Number);
for (const n of nums) {
  const m = roadmap.match(new RegExp('^\\| B' + n + ' \\| (.*?) \\| (.*?) \\| (.*?) \\|\\s*$', 'm'));
  if (!m) { console.error('B' + n + ' missing'); process.exitCode = 1; continue; }
  const body = [
    '### Description', clean(m[1]), '',
    '### Evidence / Resolution', clean(m[2]), '',
    '### Files', clean(m[3]), '',
    '_Filed retroactively from docs/06-world-class-roadmap.md bug row B' + n + '._',
  ].join('\n');
  const file = path.join(os.tmpdir(), 'issue-b' + n + '.md');
  fs.writeFileSync(file, body);
  const labs = (labels[n] || ['bug', 'resolved']).map(l => ' --label ' + l).join('');
  const title = '[B' + n + '] ' + titles[n];
  try {
    const out = execSync('gh issue create --title ' + JSON.stringify(title) + ' --body-file ' + JSON.stringify(file) + labs, { encoding: 'utf8' }).trim();
    console.log('OK B' + n + ' ' + out);
  } catch (e) {
    console.error('FAIL B' + n + ' ' + (e.stderr || e.message));
    process.exitCode = 1;
  }
}
