import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { tempDir } from './tmp.mjs';
import { newMeeting } from '../lib/meeting.mjs';
import { makeTranscriber } from '../lib/live.mjs';

const said = {
  'me-0001.m4a': [{ start: 1, end: 3, text: 'Shall we start?' }],
  'them-0001.m4a': [{ start: 4, end: 7, text: 'Yes. First, the release date.' }],
  'me-0002.m4a': [{ start: 2, end: 3.5, text: 'Sounds good.' }],
  'them-0002.m4a': [{ start: 0.5, end: 2, text: 'We ship on Friday.' }],
};
const meeting = () => {
  const m = newMeeting(tempDir('aside-'), { title: 'Release sync', claude: 'allowed', keepAudio: false, backend: 'auto', app: '' });
  m.meta.chunks.push({ n: 1, them: 0, me: 0, done: false }, { n: 2, them: 15.25, me: 15.5, done: false });
  return m;
};

test('chunks are transcribed in order and their times move onto the meeting clock', async () => {
  const m = meeting();
  let shown = null;
  const asr = { ready: true, transcribe: async (path) => ({ sentences: said[basename(path)] }) };
  assert.equal(await makeTranscriber({ meeting: m, getAsr: () => asr, onLines: (l) => { shown = l; } }).run(), true);
  assert.deepEqual(shown.map((l) => [l.speaker, l.start, l.text]), [
    ['Me', 1, 'Shall we start?'],
    ['Them', 4, 'Yes. First, the release date.'],
    ['Them', 15.75, 'We ship on Friday.'],
    ['Me', 17.5, 'Sounds good.'],
  ]);
  assert.ok(m.meta.chunks.every((c) => c.done));
});

test('a chunk waits while the speech worker is down, and runs when it is back', async () => {
  const m = meeting();
  const asr = { ready: false, transcribe: async (path) => ({ sentences: said[basename(path)] }) };
  const t = makeTranscriber({ meeting: m, getAsr: () => asr, onLines: () => {} });
  assert.equal(await t.run(), false);
  assert.equal(m.meta.chunks[0].done, false);
  asr.ready = true;
  assert.equal(await t.run(), true);
  assert.ok(m.meta.chunks.every((c) => c.done));
});

test('a chunk that fails three times is skipped, so later chunks still arrive', async () => {
  const m = meeting();
  let shown = [];
  const asr = { ready: true, transcribe: async (path) => { if (path.endsWith('-0001.m4a')) throw new Error('cannot decode'); return { sentences: said[basename(path)] }; } };
  const t = makeTranscriber({ meeting: m, getAsr: () => asr, onLines: (l) => { shown = l; } });
  assert.equal(await t.run(), false);
  assert.equal(await t.run(), false);
  assert.equal(await t.run(), true);
  assert.equal(m.meta.chunks[0].failed, true);
  assert.deepEqual(shown.map((l) => l.text), ['We ship on Friday.', 'Sounds good.']);
});

test('one track that fails alone does not lose the other track', async () => {
  const m = meeting();
  let shown = [];
  const asr = { ready: true, transcribe: async (path) => { if (basename(path) === 'me-0002.m4a') throw new Error('audio too short'); return { sentences: said[basename(path)] }; } };
  assert.equal(await makeTranscriber({ meeting: m, getAsr: () => asr, onLines: (l) => { shown = l; } }).run(), true);
  assert.deepEqual(shown.map((l) => l.text), ['Shall we start?', 'Yes. First, the release date.', 'We ship on Friday.']);
  assert.ok(m.meta.chunks.every((c) => c.done && !c.failed));
});

test('an unexpected error resolves to false instead of rejecting, because callers do not wait', async () => {
  const m = meeting();
  const t = makeTranscriber({ meeting: m, getAsr: () => { throw new Error('worker state unreadable'); }, onLines: () => {} });
  assert.equal(await t.run(), false);
});
