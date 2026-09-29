import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from '../dist/src/process.js';

const fixture = mkdtempSync(join(tmpdir(), 'agentmesh-package-'));
try {
  const archive = runSync('npm', ['pack', '--pack-destination', fixture], process.cwd()).split(/\r?\n/).at(-1);
  if (!archive) throw new Error('npm pack produced no archive');
  runSync('npm', ['install', '--prefix', fixture, '--ignore-scripts', join(fixture, archive)], fixture);
  const cli = join(fixture, 'node_modules', 'agentmesh', 'dist', 'src', 'cli.js');
  const project = join(fixture, 'project'); mkdirSync(project);
  const result = JSON.parse(runSync(process.execPath, [cli, 'init', '--root', project, '--type', 'library'], project));
  const checks = JSON.parse(runSync(process.execPath, [cli, 'doctor', '--root', project], project));
  if (!result.plan || checks.database.ok !== true || checks.database.detail !== 'ok') throw new Error('Installed package smoke failed');
  console.log(JSON.stringify({ ok: true, archive, initialized: result.plan }));
} finally { rmSync(fixture, { recursive: true, force: true }); }
