import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redact, loadRedactions } from '../lib/redact.mjs';

test('redact removes every line that matches a pattern and keeps the rest', () => {
  const text = '[0:05] Them: Call me on +91 98765 43210 after lunch.\n[0:09] Me: Sure, and the release is on Friday.\n[0:14] Them: My email is ravi.k@example.com.';
  assert.equal(redact(text, [/\+?91[\s-]?\d{5}\s?\d{5}/i, /@[\w.-]+\.\w/i]), '[0:09] Me: Sure, and the release is on Friday.');
});

test('loadRedactions reads aside.config.json, and no file means no patterns', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-cfg-'));
  assert.deepEqual(loadRedactions(root), []);
  writeFileSync(join(root, 'aside.config.json'), JSON.stringify({ redact: ['\\bCTC\\b'] }));
  const [re] = loadRedactions(root);
  assert.ok(re.test('Them: my current ctc is fixed'), 'case-insensitive');
});
