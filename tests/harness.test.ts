import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexOutput, parseCursorOutput, parseGeminiOutput } from '../src/harness.js';

test('Codex JSONL keeps the latest final message and session for resume', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'finished' } }),
  ].join('\n');
  assert.deepEqual(parseCodexOutput(output), { text: 'finished', sessionId: 'thread-1', raw: output });
  assert.throws(() => parseCodexOutput('{"type":"turn.failed","error":{"message":"denied"}}\n'), /turn failed/);
  assert.throws(() => parseCodexOutput('{"type":"thread.started","thread_id":"x"}\n'), /no final response/);
});

test('Cursor JSON preserves session and rejects empty or error results', () => {
  const output = JSON.stringify({ result: 'done', session_id: 'cursor-1' });
  assert.deepEqual(parseCursorOutput(output), { text: 'done', sessionId: 'cursor-1', raw: output });
  assert.equal(parseCursorOutput('{"result":"done"}', 'prior').sessionId, 'prior');
  assert.throws(() => parseCursorOutput('{"result":""}'), /no final response/);
  assert.throws(() => parseCursorOutput('{"error":"failure"}'), /cursor failed/);
});

test('Gemini JSON preserves session and treats embedded errors as failures', () => {
  const output = JSON.stringify({ response: 'done', session_id: 'gemini-1', stats: {} });
  assert.deepEqual(parseGeminiOutput(output), { text: 'done', sessionId: 'gemini-1', raw: output });
  assert.throws(() => parseGeminiOutput('{"error":{"type":"API","message":"failure"}}'), /gemini failed/);
  assert.throws(() => parseGeminiOutput('{"response":" "}'), /no final response/);
});
