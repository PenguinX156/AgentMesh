import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../src/process.js';

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
