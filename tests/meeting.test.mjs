import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { newMeeting, saveMeta, loadMeta, pendingChunks, cleanupAudio, adoptChunks, unfinishedMeetings } from '../lib/meeting.mjs';

const settings = (title, keepAudio = false) => ({ title, claude: 'allowed', keepAudio, backend: 'auto', app: 'zoom.us' });
const audio = (dir, ...names) => { for (const f of names) writeFileSync(join(dir, f), Buffer.alloc(16)); };

test('pendingChunks lists the chunks not yet transcribed, oldest first', () => {
  const meta = { chunks: [{ n: 3, done: false }, { n: 1, done: true }, { n: 2, done: false }] };
  assert.deepEqual(pendingChunks(meta).map((c) => c.n), [2, 3]);
});

test('newMeeting names the folder by date and title, and unfinishedMeetings lists the ones not done', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-'));
  const a = newMeeting(root, settings('Sprint planning'), new Date('2026-10-15T09:30:00Z'));
  assert.equal(basename(a.dir), '2026-10-15-09-30-sprint-planning');
  const b = newMeeting(root, settings('Retro'), new Date('2026-10-15T11:00:00Z'));
  b.meta.done = true;
  saveMeta(b.dir, b.meta);
  assert.deepEqual(unfinishedMeetings(root), ['2026-10-15-09-30-sprint-planning']);
});

test('a second meeting with the same title in the same minute gets its own folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-'));
  const at = new Date('2026-10-15T09:30:00Z');
  const first = newMeeting(root, settings('Standup'), at);
  const second = newMeeting(root, { ...settings('Standup'), claude: 'local' }, at);
  assert.equal(basename(second.dir), '2026-10-15-09-30-standup-2');
  assert.equal(loadMeta(first.dir).claude, 'allowed', 'the first meeting is untouched');
});

test('cleanupAudio deletes only transcribed chunks, and keeps failed and unannounced ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-'));
  const { dir, meta } = newMeeting(root, settings('Design review'), new Date('2026-10-15T09:30:00Z'));
  meta.chunks.push({ n: 1, them: 0, me: 0, done: true }, { n: 2, them: 15, me: 15, done: true, failed: true });
  audio(dir, 'me-0001.m4a', 'them-0001.m4a', 'me-0002.m4a', 'them-0002.m4a', 'me-0003.m4a', 'them-0003.m4a');
  writeFileSync(join(dir, 'notes.md'), '# Design review\n');
  assert.equal(cleanupAudio(dir, meta), 2);
  assert.deepEqual(readdirSync(dir).sort(), ['me-0002.m4a', 'me-0003.m4a', 'meeting.json', 'notes.md', 'them-0002.m4a', 'them-0003.m4a', 'transcript.json']);
  const kept = newMeeting(root, settings('Customer call', true), new Date('2026-10-15T10:00:00Z'));
  kept.meta.chunks.push({ n: 1, them: 0, me: 0, done: true });
  audio(kept.dir, 'me-0001.m4a');
  assert.equal(cleanupAudio(kept.dir, kept.meta), 0);
  assert.ok(existsSync(join(kept.dir, 'me-0001.m4a')));
});

test('adoptChunks adds a complete chunk pair that the recorder never announced', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-'));
  const { dir, meta } = newMeeting(root, settings('Release sync'), new Date('2026-10-15T09:30:00Z'));
  meta.chunks.push({ n: 1, them: 0, me: 0, done: true });
  audio(dir, 'me-0001.m4a', 'them-0001.m4a', 'me-0002.m4a', 'them-0002.m4a', 'them-0003.m4a');
  assert.equal(adoptChunks(dir, meta), 1, 'chunk 3 has no microphone file, so it is not a pair');
  assert.deepEqual(meta.chunks[1], { n: 2, them: 15, me: 15, done: false });
});
