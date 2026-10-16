import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
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

test('savePrefs refuses a body that is not an object', () => {
  const root = dir();
  for (const bad of [null, [], 5, 'x']) {
    assert.throws(() => savePrefs(root, bad), { code: 400 }, JSON.stringify(bad));
  }
  assert.equal(existsSync(join(root, 'prefs.json')), false, 'nothing was written');
});

test('a hot key needs two different modifiers, one of them Command or Control', () => {
  const root = dir();
  for (const bad of ['cmd+c', 'ctrl+9', 'cmd+cmd+c']) {
    assert.throws(() => savePrefs(root, { hotkeyOpen: bad }), { code: 400 }, bad);
  }
  for (const good of ['opt+cmd+a', 'shift+ctrl+9', 'ctrl+opt+shift+cmd+z']) {
    assert.equal(savePrefs(root, { hotkeyOpen: good }).hotkeyOpen, good);
  }
});

test('savePrefs takes a valid hot key but refuses two equal ones', () => {
  const root = dir();
  savePrefs(root, { hotkeyOpen: 'shift+ctrl+9' });
  assert.equal(loadPrefs(root).hotkeyOpen, 'shift+ctrl+9');
  const other = dir();
  assert.throws(() => savePrefs(other, { hotkeyAsk: 'opt+cmd+a' }), { code: 400 });
  assert.equal(loadPrefs(other).hotkeyAsk, 'opt+cmd+k');
});

test('meetingsBase uses the repository folder unless the user picked another', () => {
  assert.equal(meetingsBase('/repo', DEFAULTS), '/repo/meetings');
  assert.equal(meetingsBase('/repo', { ...DEFAULTS, meetingsDir: '~/Documents/aside' }), join(homedir(), 'Documents/aside'));
});
