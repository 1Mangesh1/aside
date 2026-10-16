import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadPrefs, savePrefs, meetingsBase, DEFAULTS } from '../lib/prefs.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'aside-prefs-'));

test('loadPrefs gives the defaults when there is no file', () => {
  assert.deepEqual(loadPrefs(dir()), DEFAULTS);
});

test('savePrefs merges a change, keeps the rest and survives a reload', () => {
  const root = dir();
  savePrefs(root, { backend: 'cli', keepAudio: true });
  const p = loadPrefs(root);
  assert.equal(p.backend, 'cli');
  assert.equal(p.keepAudio, true);
  assert.equal(p.hotkeyOpen, 'opt+cmd+a');
});

test('savePrefs refuses values the app cannot use', () => {
  const root = dir();
  for (const bad of [{ backend: 'gpt' }, { hotkeyOpen: 'shift+a' }, { hotkeyAsk: 'opt+k' }, { detectApps: 'zoom' }, { meetingsDir: 'relative/path' }, { surprise: 1 }]) {
    assert.throws(() => savePrefs(root, bad), { code: 400 }, JSON.stringify(bad));
  }
  assert.deepEqual(loadPrefs(root), DEFAULTS, 'nothing was written');
});

test('meetingsBase uses the repository folder unless the user picked another', () => {
  assert.equal(meetingsBase('/repo', DEFAULTS), '/repo/meetings');
  assert.equal(meetingsBase('/repo', { ...DEFAULTS, meetingsDir: '~/Documents/aside' }), join(homedir(), 'Documents/aside'));
});
