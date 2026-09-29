import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runSync } from '../src/process.js';

test('Windows batch launcher preserves arguments without shell interpretation', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-command-'));
  try {
    const script = join(root, 'fixture.cmd');
    writeFileSync(script, '@echo off\r\nnode -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n');
    const args = ['hello world', 'x&echo INJECTED', 'literal $(whoami)', 'quote " text'];
    const output = runSync(script, args, root);
    assert.deepEqual(JSON.parse(output), args);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('abort terminates a running subprocess', async () => {
  const controller = new AbortController();
  const running = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /cancelled/);
});
