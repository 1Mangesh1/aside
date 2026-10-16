// aside: a local meeting companion on 127.0.0.1:4318. It records a call (system audio + microphone), transcribes it
// on this Mac in 15-second chunks, answers questions about the call with Claude while it runs, and writes the notes.
// Usage: npm start, then open http://127.0.0.1:4318. Build the recorder once with: npm run build:capture
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { modelDir, modelState, deleteModel, startAsr, MODEL_BYTES, ASR_MODEL } from './lib/asr.mjs';
import { makeClaude } from './lib/claude.mjs';
import { transcriptText, notesFile, NOTES_SYSTEM, COMPANION_SYSTEM, ASK_MEETINGS_SYSTEM, companionPrompt } from './lib/notes.mjs';
import { loadRedactions, redact } from './lib/redact.mjs';
import { newMeeting, loadMeta, saveMeta, loadTranscript, cleanupAudio, adoptChunks, unfinishedMeetings, listMeetings } from './lib/meeting.mjs';
import { makeTranscriber } from './lib/live.mjs';
import { loadPrefs, savePrefs, meetingsBase } from './lib/prefs.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 4318;

// Only the page served from this machine may call the API endpoints: Host blocks DNS rebinding,
// and Origin blocks another site's page from spending credit or starting a recording through a cross-site POST.
export function allowedOrigin(req, port) {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!own.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  return own.some((h) => req.headers.origin === `http://${h}`);
}

const fail = (message, code) => Object.assign(new Error(message), { code });
const body = async (req) => { const parts = []; for await (const c of req) parts.push(c); return Buffer.concat(parts); };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const backendOf = (b) => (['api', 'cli'].includes(b) ? b : 'auto');
// Every route that can send text to Claude checks this first, so text from a local-only meeting never leaves the Mac.
const claudeAllowed = (meta) => meta.claude === 'allowed';

// Starts the Swift recorder. closed resolves once the recorder has exited and its last chunk line was read, whether
// stop() asked for it or the capture died by itself; stop() sends SIGINT only to a recorder that still runs.
export function startRecorder(bin, out, app, onChunk) {
  if (!existsSync(bin)) throw fail('Build the recorder first: npm run build:capture', 400);
  const child = spawn(bin, app ? [out, app] : [out], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const closed = new Promise((done) => child.on('close', done));
  return new Promise((ok, no) => {
    createInterface({ input: child.stdout }).on('line', (l) => {
      if (l === 'recording') ok({ closed, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT'); return closed; } });
      const m = l.match(/^chunk (\d+) ([\d.]+) ([\d.]+)$/);
      if (m) onChunk(Number(m[1]), Number(m[2]), Number(m[3]));
    });
    closed.then(() => no(fail(err.trim() || 'The recorder stopped before it started.', 500)));
  });
}

export function makeRoutes({ base, claude, getAsr, record, redactions = [], emit = () => {} }) {
  let live = null; // { dir, meta, child, transcriber }
  let starting = false; // a second Start during the recorder's start-up would run two recorders
  const finishing = new Set(); // meeting ids being finished, so a second tab cannot finish one twice
  const dirOf = (id) => {
    if (!/^[\w-]+$/.test(id) || !existsSync(join(base, id, 'meeting.json'))) throw fail('Unknown meeting.', 404);
    return join(base, id);
  };

  async function writeNotes(dir, meta) {
    const t = loadTranscript(dir);
    const minutes = Math.max(1, Math.round(((meta.stoppedAt || Date.now()) - meta.startedAt) / 60000));
    const date = new Date(meta.startedAt).toISOString().slice(0, 10);
    let notes = '## Summary\n\nNo speech was heard in this recording.';
    if (!claudeAllowed(meta)) notes = '## Summary\n\nLocal only: nothing went to Claude, so there are no notes. The transcript is below.';
    else if (t.lines.length) {
      const r = await claude.ask(meta.backend, { system: NOTES_SYSTEM, prompt: redact(transcriptText(t.lines), redactions), effort: 'medium' });
      meta.spent += r.cost;
      notes = r.text;
    }
    writeFileSync(join(dir, 'notes.md'), notesFile({ title: meta.title, date, minutes, notes, lines: t.lines }));
  }

  // Transcribes what is left, writes the notes, and only then deletes the audio. If the notes fail, the meeting
  // stays unfinished with its transcript and audio, and "Finish it" tries again. A failing chunk gets its three
  // tries here, so one bad file cannot keep the meeting from finishing.
  async function finish(dir, meta, transcriber) {
    for (let i = 0; !(await transcriber.run()); i++) {
      if (!getAsr()?.ready) throw fail('The speech model is not loaded, so the rest of the call cannot be transcribed yet. Load it, then try again.', 503);
      if (i > 3 * meta.chunks.length) throw fail('Some chunks could not be transcribed. Press "Finish it" to try again.', 500);
    }
    await writeNotes(dir, meta);
    meta.done = true;
    saveMeta(dir, meta);
    cleanupAudio(dir, meta);
    return { id: basename(dir), markdown: readFileSync(join(dir, 'notes.md'), 'utf8') };
  }

  const routes = {
    'POST /api/meeting/start': async (d) => {
      if (live || starting) throw fail('A meeting is already recording.', 409);
      if (!['allowed', 'local'].includes(d.claude)) throw fail('Choose "Claude allowed" or "local only" first.', 400);
      starting = true;
      try {
        const m = newMeeting(base, { title: String(d.title || '').trim() || 'Meeting', claude: d.claude, keepAudio: !!d.keepAudio, backend: backendOf(d.backend), app: String(d.app || '').trim() });
        const id = basename(m.dir);
        m.transcriber = makeTranscriber({ meeting: m, getAsr, onLines: (lines) => emit({ type: 'lines', id, lines }) });
        try {
          m.child = await record(m.dir, m.meta.app, (n, them, me) => {
            if (m.meta.chunks.some((c) => c.n === n)) return; // a repeated SIGINT can announce the last chunk twice
            m.meta.chunks.push({ n, them, me, done: false });
            saveMeta(m.dir, m.meta);
            m.transcriber.run();
          });
        } catch (e) {
          rmSync(m.dir, { recursive: true, force: true }); // nothing was recorded
          throw e;
        }
        m.child.closed?.then(() => { if (live === m) emit({ type: 'error', message: 'The recorder stopped by itself. Press "Stop and write notes" to keep what it recorded.' }); });
        live = m;
        emit({ type: 'state' });
        return { id, title: m.meta.title, claude: m.meta.claude };
      } finally {
        starting = false;
      }
    },
    'POST /api/meeting/stop': async () => {
      const m = live;
      if (!m) throw fail('Nothing is recording.', 400);
      live = null; // a second Stop now gets "Nothing is recording" instead of a second set of notes
      const id = basename(m.dir);
      finishing.add(id);
      try {
        await m.child.stop();
        m.meta.stoppedAt = Date.now();
        saveMeta(m.dir, m.meta);
        emit({ type: 'state' });
        return await finish(m.dir, m.meta, m.transcriber);
      } finally {
        finishing.delete(id);
      }
    },
    'POST /api/meeting/ask': async (d) => {
      const m = live;
      if (!m) throw fail('Nothing is recording.', 400);
      if (!claudeAllowed(m.meta)) throw fail('This meeting is local only, so nothing goes to Claude.', 403);
      const question = String(d.question || '').trim();
      if (!question) throw fail('Ask a question first.', 400);
      const id = Date.now().toString(36);
      emit({ type: 'answer-start', id, question });
      const prompt = companionPrompt(redact(transcriptText(loadTranscript(m.dir).lines), redactions), question);
      const r = await claude.ask(m.meta.backend, { system: COMPANION_SYSTEM, prompt, effort: 'low', onText: (text) => emit({ type: 'answer-delta', id, text }) });
      m.meta.spent += r.cost;
      saveMeta(m.dir, m.meta);
      appendFileSync(join(m.dir, 'companion.md'), `## ${question}\n\n${r.text.trim()}\n\n`);
      emit({ type: 'answer-end', id, cost: m.meta.spent });
      return { id, text: r.text, cost: m.meta.spent, backend: r.backend };
    },
    'POST /api/meetings/finish': async (d) => {
      if (live) throw fail('Stop the current recording first.', 409);
      const id = String(d.id || '');
      const dir = dirOf(id);
      if (finishing.has(id)) throw fail('This meeting is being finished already.', 409);
      const meta = loadMeta(dir);
      if (meta.done) throw fail('This meeting is already finished.', 400);
      finishing.add(id);
      try {
        adoptChunks(dir, meta);
        saveMeta(dir, meta);
        const m = { dir, meta };
        m.transcriber = makeTranscriber({ meeting: m, getAsr, onLines: () => {} });
        return await finish(dir, meta, m.transcriber);
      } finally {
        finishing.delete(id);
      }
    },
    'POST /api/meetings/ask': async (d) => {
      const ids = [].concat(d.ids || []).map(String);
      const question = String(d.question || '').trim();
      if (!ids.length || !question) throw fail('Pick meetings and ask a question.', 400);
      const picked = ids.map((id) => { const dir = dirOf(id); return { dir, meta: loadMeta(dir) }; });
      const allowed = picked.filter((x) => claudeAllowed(x.meta) && existsSync(join(x.dir, 'notes.md')));
      if (!allowed.length) throw fail('None of these meetings allows Claude.', 403);
      const blocks = allowed.map((x) => `<meeting title="${x.meta.title.replace(/"/g, "'")}" date="${new Date(x.meta.startedAt).toISOString().slice(0, 10)}">\n${redact(readFileSync(join(x.dir, 'notes.md'), 'utf8'), redactions)}\n</meeting>`);
      const r = await claude.ask(backendOf(d.backend), { system: ASK_MEETINGS_SYSTEM, prompt: `${blocks.join('\n\n')}\n\nQuestion: ${question}`, effort: 'medium' });
      return { text: r.text, cost: r.cost, skipped: picked.length - allowed.length };
    },
    'GET /api/meetings': async () => ({ meetings: listMeetings(base), unfinished: unfinishedMeetings(base).filter((id) => !finishing.has(id) && (!live || id !== basename(live.dir))) }),
  };

  return {
    routes,
    current: () => live && { id: basename(live.dir), title: live.meta.title, claude: live.meta.claude, startedAt: live.meta.startedAt, spent: live.meta.spent },
    lines: () => (live ? { id: basename(live.dir), lines: loadTranscript(live.dir).lines } : null),
    runPending: () => live?.transcriber.run(),
  };
}

export function serve() {
  const claude = makeClaude({ root: ROOT });
  const dir = modelDir();
  const recorder = join(ROOT, 'bin/aside-capture');
  let prefs = loadPrefs(ROOT);
  const base = meetingsBase(ROOT, prefs);
  // The worker loads (and, if missing, downloads) the model, so start it only when the model is already here.
  let asr = modelState(dir).downloaded ? startAsr(join(ROOT, 'asr_worker.py')) : null;
  const ensureAsr = () => { if (modelState(dir).downloaded && (!asr || asr.exited)) asr = startAsr(join(ROOT, 'asr_worker.py')); };
  const clients = new Set();
  const emit = (event) => { for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const app = makeRoutes({ base, claude, getAsr: () => asr, redactions: loadRedactions(ROOT), emit, record: (out, name, onChunk) => startRecorder(recorder, out, name, onChunk) });
  // A restarted speech worker picks up the chunks that waited while it was down.
  setInterval(() => { ensureAsr(); app.runPending(); }, 5000).unref();

  const status = () => {
    ensureAsr();
    const m = modelState(dir);
    return {
      asrReady: !!asr?.ready,
      model: { ...m, name: ASR_MODEL, expectedBytes: MODEL_BYTES, downloading: !!asr && !asr.ready && !asr.exited },
      claude: claude.status(),
      recorder: existsSync(recorder),
      meeting: app.current(),
    };
  };
  const routes = {
    ...app.routes,
    'POST /api/model/download': async () => { if (!asr || asr.exited) asr = startAsr(join(ROOT, 'asr_worker.py')); return status(); },
    'POST /api/model/delete': async () => {
      if (app.current()) throw fail('Stop the recording first.', 409);
      if (asr) { asr.kill(); asr = null; }
      deleteModel(dir);
      return status();
    },
    'GET /api/prefs': async () => prefs,
    'POST /api/prefs': async (d) => { prefs = savePrefs(ROOT, d); emit({ type: 'prefs' }); return prefs; },
  };

  createServer(async (req, res) => {
    if (!allowedOrigin(req, PORT)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        // No framing: another site's page cannot overlay this one and trick a click on Start.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
        return res.end(readFileSync(join(ROOT, 'public/index.html')));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, status());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const snapshot = app.lines();
        if (snapshot) res.write(`data: ${JSON.stringify({ type: 'lines', ...snapshot })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/meetings/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/meetings/'.length));
        const mdir = join(base, id);
        if (!/^[\w-]+$/.test(id) || !existsSync(join(mdir, 'meeting.json'))) return send(res, 404, { error: 'not found' });
        const read = (f) => (existsSync(join(mdir, f)) ? readFileSync(join(mdir, f), 'utf8') : '');
        return send(res, 200, { id, meta: loadMeta(mdir), notes: read('notes.md'), companion: read('companion.md') });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'not found' });
      const data = req.method === 'POST' ? JSON.parse((await body(req)).toString() || '{}') : {};
      return send(res, 200, await route(data));
    } catch (e) {
      console.error(e.message);
      return send(res, e.code >= 400 ? e.code : e.status >= 400 ? e.status : 500, { error: e.message });
    }
  }).listen(PORT, '127.0.0.1', () => console.log(`aside: http://127.0.0.1:${PORT}`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) serve();
