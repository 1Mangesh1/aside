// On-device speech to text: a Parakeet worker (asr_worker.py) that starts when a meeting needs it, if the model is
// downloaded, and stops after 10 idle minutes. Also the model's place on disk.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, statSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const ASR_MODEL = 'mlx-community/parakeet-tdt-0.6b-v3';
export const MODEL_BYTES = 2_508_000_000; // model.safetensors on Hugging Face, checked 2026-10-15

// Where huggingface_hub keeps this model: HF_HUB_CACHE, else $HF_HOME/hub, else ~/.cache/huggingface/hub.
export function modelDir(env = process.env, home = homedir()) {
  const hub = env.HF_HUB_CACHE || join(env.HF_HOME || join(home, '.cache/huggingface'), 'hub');
  return join(hub, `models--${ASR_MODEL.replace('/', '--')}`);
}

// The model's blobs/ holds the files, or (newer huggingface_hub) links into the hub-wide store hub/blobs/<xx>/<sha>.
// Each link is resolved so the real size is counted once. An .incomplete blob means a download is in progress.
function blobTargets(dir) {
  const blobs = join(dir, 'blobs'), out = new Set();
  let incomplete = false;
  if (existsSync(blobs)) for (const name of readdirSync(blobs)) {
    if (name.endsWith('.incomplete')) incomplete = true;
    try { out.add(realpathSync(join(blobs, name))); } catch { /* dangling link from an interrupted download */ }
  }
  return { targets: out, incomplete };
}

export function modelState(dir, expected = MODEL_BYTES) {
  const { targets, incomplete } = blobTargets(dir);
  const bytes = [...targets].reduce((sum, p) => sum + statSync(p).size, 0);
  return { bytes, downloaded: !incomplete && bytes >= expected };
}

// Removes the model folder, then each shared-store file it linked to that no other model in the hub still links to.
export function deleteModel(dir) {
  const hub = realpathSync(dirname(dir));
  const { targets } = blobTargets(dir);
  rmSync(dir, { recursive: true, force: true });
  const stillUsed = new Set(readdirSync(hub).filter((n) => n.startsWith('models--')).flatMap((n) => [...blobTargets(join(hub, n)).targets]));
  for (const t of targets) if (t.startsWith(hub + '/') && !stillUsed.has(t)) rmSync(t, { force: true });
}

// Starts the worker; it loads the model (downloading it first if missing) and then answers one request per line.
export function startAsr(workerPath) {
  const worker = spawn('uv', ['run', '--quiet', '--python', '3.12', '--with', 'parakeet-mlx==0.5.3', 'python', workerPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let seq = 0;
  const asr = { ready: false, exited: false, kill: () => worker.kill() };
  createInterface({ input: worker.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.ready) { asr.ready = true; console.log('Speech model ready.'); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
  });
  const stopped = (why) => {
    asr.ready = false; asr.exited = true;
    for (const p of pending.values()) p.reject(new Error('The speech worker stopped.'));
    pending.clear();
    console.error(`Speech worker stopped (${why}).`);
  };
  worker.on('exit', (code) => stopped(`exit ${code}`));
  // uv not on PATH: spawn emits 'error' and never 'exit'.
  worker.on('error', (e) => { asr.error = e.message; stopped(e.message); });
  // A write to a worker that just died fails with EPIPE; unhandled, that kills the server. Its 'exit' rejects the requests.
  worker.stdin.on('error', () => {});
  // sentences: true also returns [{start, end, text}] in seconds, for merging two meeting tracks.
  asr.transcribe = (path, { sentences = false } = {}) => new Promise((resolve, reject) => {
    if (asr.exited) return reject(new Error('The speech worker stopped.'));
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    worker.stdin.write(JSON.stringify({ id, path, sentences }) + '\n');
  });
  return asr;
}

// Keeps the worker (and the model in memory) only while it is needed: started on want() or a busy tick, stopped
// after idleMs without either. set() hands it a worker started elsewhere, for the model download route. A worker
// that is still downloading or loading the model counts as busy, so a download longer than idleMs is not cut off.
export function makeAsrManager({ start, downloaded, idleMs = 600_000, now = Date.now }) {
  let asr = null, last = now();
  const alive = () => asr && !asr.exited;
  const m = {
    get: () => asr,
    set: (a) => { asr = a; last = now(); },
    want() { last = now(); if (!alive() && downloaded()) asr = start(); return asr; },
    tick(busy) {
      if (busy || (alive() && !asr.ready)) return m.want();
      if (alive() && now() - last >= idleMs) { asr.kill(); asr = null; }
    },
  };
  return m;
}
