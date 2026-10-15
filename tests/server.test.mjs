import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedOrigin, makeRoutes, startRecorder } from '../server.mjs';
import { newMeeting } from '../lib/meeting.mjs';

const fakeClaude = () => {
  const calls = [];
  return { calls, status: () => ({}), ask: async (kind, req) => { calls.push(req); req.onText?.('Friday.'); return { text: '## Summary\n\n- The release is on Friday.', cost: 0.01, backend: 'api' }; } };
};
const asr = { ready: true, transcribe: async (path) => ({ sentences: path.includes('them-') ? [{ start: 0.5, end: 3, text: 'Call me on +91 98765 43210 about the release.' }] : [{ start: 4, end: 5, text: 'Sure, Friday works.' }] }) };
function setup({ claude = fakeClaude(), emit } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aside-'));
  const rec = {};
  const record = async (dir, app, onChunk) => { Object.assign(rec, { dir, onChunk }); return { stop: async () => {} }; };
  const app = makeRoutes({ root, claude, getAsr: () => asr, record, emit, redactions: [/\+?91[\s-]?\d{5}\s?\d{5}/i] });
  return { root, claude, rec, app, routes: app.routes };
}
// A Claude double that holds every answer until open() is called.
const gatedClaude = () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const calls = [];
  return { calls, open, status: () => ({}), ask: async (kind, req) => { calls.push(req); await gate; return { text: '## Summary\n\n- The release is on Friday.', cost: 0, backend: 'api' }; } };
};
// One recorded chunk: the files exist (the fake worker ignores their content) and the recorder announces them.
const chunk = (rec, n) => { for (const t of ['me', 'them']) writeFileSync(join(rec.dir, `${t}-000${n}.m4a`), Buffer.alloc(16)); rec.onChunk(n, 0, 0); };

test('allowedOrigin accepts only this page on this machine', () => {
  const ok = (h, method = 'POST') => allowedOrigin({ method, headers: h }, 4318);
  assert.ok(ok({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318' }));
  assert.ok(ok({ host: 'localhost:4318', origin: 'http://localhost:4318' }));
  assert.ok(!ok({ host: '127.0.0.1:4318', origin: 'https://evil.example' }), 'another site');
  assert.ok(!ok({ host: '127.0.0.1:4318' }), 'no Origin');
  assert.ok(!ok({ host: 'evil.example:4318', origin: 'http://evil.example:4318' }), 'DNS rebinding Host');
  assert.ok(ok({ host: '127.0.0.1:4318' }, 'GET'), 'GET of the page');
});

test('a meeting cannot start without the Claude choice', async () => {
  const { routes } = setup();
  await assert.rejects(routes['POST /api/meeting/start']({ title: 'Standup' }), { code: 400 });
});

test('a local-only meeting never calls Claude', async () => {
  const { routes, claude, rec } = setup();
  await routes['POST /api/meeting/start']({ title: 'Patient follow-up', claude: 'local' });
  chunk(rec, 1);
  await assert.rejects(routes['POST /api/meeting/ask']({ question: 'What was decided?' }), { code: 403 });
  const out = await routes['POST /api/meeting/stop']();
  assert.match(out.markdown, /Local only/);
  assert.match(out.markdown, /Sure, Friday works\./);
  assert.equal(claude.calls.length, 0);
});

test('an allowed meeting redacts before Claude and deletes the audio after the notes', async () => {
  const { routes, claude, rec, app } = setup();
  await routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  chunk(rec, 1);
  await app.runPending();
  const a = await routes['POST /api/meeting/ask']({ question: 'When do we ship?' });
  assert.equal(a.text, '## Summary\n\n- The release is on Friday.');
  const out = await routes['POST /api/meeting/stop']();
  assert.match(out.markdown, /The release is on Friday\./);
  assert.equal(claude.calls.length, 2, 'one question and the notes');
  for (const call of claude.calls) assert.ok(!call.prompt.includes('98765'), 'the phone line never reaches Claude');
  assert.ok(claude.calls.every((c) => c.prompt.includes('Sure, Friday works.')));
  assert.ok(!existsSync(join(rec.dir, 'me-0001.m4a')) && !existsSync(join(rec.dir, 'them-0001.m4a')));
  assert.match(readFileSync(join(rec.dir, 'companion.md'), 'utf8'), /## When do we ship\?/);
});

test('a question across meetings skips the local-only ones', async () => {
  const { routes, claude, rec } = setup();
  const local = await routes['POST /api/meeting/start']({ title: 'Patient follow-up', claude: 'local' });
  chunk(rec, 1);
  await routes['POST /api/meeting/stop']();
  const allowed = await routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  chunk(rec, 1);
  await routes['POST /api/meeting/stop']();
  const r = await routes['POST /api/meetings/ask']({ ids: [local.id, allowed.id], question: 'When is the release?' });
  assert.equal(r.skipped, 1);
  const prompt = claude.calls[claude.calls.length - 1].prompt;
  assert.ok(prompt.includes('Release sync') && !prompt.includes('Patient follow-up'));
});

test('a second Start during the recorder start-up is refused', async () => {
  let release;
  const record = () => new Promise((r) => { release = () => r({ stop: async () => {} }); });
  const { routes } = makeRoutes({ root: mkdtempSync(join(tmpdir(), 'aside-')), claude: fakeClaude(), getAsr: () => asr, record });
  const first = routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  await assert.rejects(routes['POST /api/meeting/start']({ title: 'Patient follow-up', claude: 'local' }), { code: 409 });
  release();
  await first;
});

test('a second Stop is refused, and the notes are written once', async () => {
  const { routes, claude, rec } = setup();
  await routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  chunk(rec, 1);
  const [a, b] = await Promise.allSettled([routes['POST /api/meeting/stop'](), routes['POST /api/meeting/stop']()]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.code, 400);
  assert.equal(claude.calls.length, 1);
});

test('while Stop writes the notes, the meeting is not offered as unfinished and cannot be finished twice', async () => {
  const claude = gatedClaude();
  const { routes, rec } = setup({ claude });
  const { id } = await routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  chunk(rec, 1);
  const stopping = routes['POST /api/meeting/stop']();
  while (!claude.calls.length) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual((await routes['GET /api/meetings']()).unfinished, []);
  await assert.rejects(routes['POST /api/meetings/finish']({ id }), { code: 409 });
  claude.open();
  await stopping;
  assert.equal(claude.calls.length, 1);
});

test('"Finish it" adopts a chunk that the recorder closed but never announced', async () => {
  const { routes, root } = setup();
  const { dir } = newMeeting(root, { title: 'Release sync', claude: 'allowed', keepAudio: false, backend: 'auto', app: '' });
  for (const t of ['me', 'them']) writeFileSync(join(dir, `${t}-0001.m4a`), Buffer.alloc(16));
  const out = await routes['POST /api/meetings/finish']({ id: basename(dir) });
  assert.match(out.markdown, /Sure, Friday works\./);
  assert.ok(!existsSync(join(dir, 'me-0001.m4a')), 'transcribed, so the audio is deleted');
});

test('a repeated chunk announcement is ignored, and transcript events carry the meeting id', async () => {
  const events = [];
  const { routes, rec, app } = setup({ emit: (e) => events.push(e) });
  const { id } = await routes['POST /api/meeting/start']({ title: 'Release sync', claude: 'allowed' });
  chunk(rec, 1);
  rec.onChunk(1, 0, 0);
  await app.runPending();
  assert.equal(JSON.parse(readFileSync(join(rec.dir, 'meeting.json'), 'utf8')).chunks.length, 1);
  assert.ok(events.some((e) => e.type === 'lines' && e.id === id));
});

test('stop() returns for a recorder that already exited by itself, also after a signal', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aside-rec-'));
  for (const [name, script] of [['exits.sh', 'echo recording; sleep 0.3; exit 1'], ['killed.sh', 'echo recording; sleep 0.3; kill -9 $$']]) {
    const bin = join(dir, name);
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    const r = await startRecorder(bin, join(dir, 'out'), '', () => {});
    await r.closed;
    await r.stop();
  }
});
