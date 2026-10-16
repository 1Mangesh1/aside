import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.mjs';
import { modelDir, modelState, deleteModel, makeAsrManager, startAsr } from '../lib/asr.mjs';

test('modelDir follows the Hugging Face cache rules', () => {
  const name = 'models--mlx-community--parakeet-tdt-0.6b-v3';
  assert.equal(modelDir({}, '/Users/a'), `/Users/a/.cache/huggingface/hub/${name}`);
  assert.equal(modelDir({ HF_HOME: '/x' }, '/Users/a'), `/x/hub/${name}`);
  assert.equal(modelDir({ HF_HOME: '/x', HF_HUB_CACHE: '/y' }, '/Users/a'), `/y/${name}`);
});

test('modelState and deleteModel handle the shared blob store', () => {
  const hub = tempDir('aside-hub-');
  const md = (n) => join(hub, `models--${n}`);
  const mk = (n) => { mkdirSync(join(md(n), 'blobs'), { recursive: true }); symlinkSync('../../blobs/9a/sha1', join(md(n), 'blobs', 'sha1')); };
  mkdirSync(join(hub, 'blobs/9a'), { recursive: true }); writeFileSync(join(hub, 'blobs/9a/sha1'), Buffer.alloc(3000));
  assert.deepEqual(modelState(md('none')), { bytes: 0, downloaded: false });
  mk('a');
  assert.deepEqual(modelState(md('a'), 2000), { bytes: 3000, downloaded: true });
  writeFileSync(join(md('a'), 'blobs/part.incomplete'), Buffer.alloc(10));
  assert.equal(modelState(md('a'), 2000).downloaded, false, 'an .incomplete blob is a download in progress');
  mk('b');
  deleteModel(md('a'));
  assert.ok(!existsSync(md('a')) && existsSync(join(hub, 'blobs/9a/sha1')), 'a shared file another model links to stays');
  deleteModel(md('b'));
  assert.ok(!existsSync(join(hub, 'blobs/9a/sha1')), 'the shared file goes once nothing links to it');
});

test('makeAsrManager starts the worker only when wanted, and stops it after the idle time', () => {
  let t = 0, started = 0;
  const workers = [];
  const start = () => { started++; const w = { ready: true, exited: false, kill() { this.exited = true; } }; workers.push(w); return w; };
  const m = makeAsrManager({ start, downloaded: () => true, idleMs: 600_000, now: () => t });
  m.tick(false);
  assert.equal(started, 0, 'idle server: no worker');
  m.want();
  assert.equal(started, 1);
  m.want();
  assert.equal(started, 1, 'a live worker is reused');
  t = 599_000; m.tick(false);
  assert.equal(workers[0].exited, false, 'not idle long enough');
  t = 601_000; m.tick(false);
  assert.equal(workers[0].exited, true, 'stopped after 10 idle minutes');
  assert.equal(m.get(), null);
  m.tick(true);
  assert.equal(started, 2, 'busy (a meeting or waiting chunks) starts it again');
});

test('makeAsrManager never starts a worker for a model that is not on disk', () => {
  let started = 0;
  const m = makeAsrManager({ start: () => { started++; return {}; }, downloaded: () => false });
  m.want(); m.tick(true);
  assert.equal(started, 0);
});

test('makeAsrManager keeps a worker that is still downloading or loading the model', () => {
  let t = 0;
  const w = { ready: false, exited: false, kill() { this.exited = true; } };
  const m = makeAsrManager({ start: () => assert.fail('no second worker'), downloaded: () => false, now: () => t });
  m.set(w);
  t = 3_600_000; m.tick(false);
  assert.equal(w.exited, false, 'an hour-long download is not idle');
  w.ready = true;
  t += 599_000; m.tick(false);
  assert.equal(w.exited, false, 'the idle time counts from the end of the load');
  t += 2_000; m.tick(false);
  assert.equal(w.exited, true);
});

test('startAsr survives a missing uv: the worker counts as stopped and refuses requests', async () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const a = startAsr('asr_worker.py');
    await new Promise((r) => setImmediate(r));
    assert.equal(a.exited, true);
    assert.equal(a.ready, false);
    assert.equal(a.error, 'spawn uv ENOENT');
    await assert.rejects(a.transcribe('/tmp/aside-0001-me.wav'), /speech worker stopped/);
  } finally {
    process.env.PATH = path;
  }
});
