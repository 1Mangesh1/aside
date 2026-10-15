import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelDir, modelState, deleteModel } from '../lib/asr.mjs';

test('modelDir follows the Hugging Face cache rules', () => {
  const name = 'models--mlx-community--parakeet-tdt-0.6b-v3';
  assert.equal(modelDir({}, '/Users/a'), `/Users/a/.cache/huggingface/hub/${name}`);
  assert.equal(modelDir({ HF_HOME: '/x' }, '/Users/a'), `/x/hub/${name}`);
  assert.equal(modelDir({ HF_HOME: '/x', HF_HUB_CACHE: '/y' }, '/Users/a'), `/y/${name}`);
});

test('modelState and deleteModel handle the shared blob store', () => {
  const hub = mkdtempSync(join(tmpdir(), 'aside-hub-'));
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
