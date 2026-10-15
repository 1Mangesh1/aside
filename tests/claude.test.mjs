import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd } from '../lib/claude.mjs';

test('costUsd prices input, both cache writes, cache reads and output', () => {
  // 1,000 at $4 + 2,000 1h-write at $8 + 1,000 5m-write at $5 + 50,000 read at $0.20 + 500 output at $20, per MTok.
  const c = costUsd({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 50000, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 1000 } });
  assert.ok(Math.abs(c - 0.045) < 1e-9, String(c));
});
