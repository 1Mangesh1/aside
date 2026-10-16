// One meeting is one folder in the meetings folder (base): meeting.json (settings and progress), transcript.json, notes.md,
// companion.md, and the audio chunks (them-0001.m4a, me-0001.m4a, ...) until the notes are saved.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'meeting';
export const chunkFile = (dir, track, n) => join(dir, `${track}-${String(n).padStart(4, '0')}.m4a`);

// A temp file and a rename, so a crash never leaves a half-written file that breaks the meeting list.
const writeJson = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1)); renameSync(`${file}.tmp`, file); };
export const loadMeta = (dir) => JSON.parse(readFileSync(join(dir, 'meeting.json'), 'utf8'));
export const saveMeta = (dir, meta) => writeJson(join(dir, 'meeting.json'), meta);
export const loadTranscript = (dir) => JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'));
export const saveTranscript = (dir, t) => writeJson(join(dir, 'transcript.json'), t);

// claude is "allowed" or "local"; chunks gets one entry per recorder chunk: {n, them, me, done} with start offsets.
export function newMeeting(base, { title, claude, keepAudio, backend, app }, now = new Date()) {
  const name = `${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${slug(title)}`;
  let dir = join(base, name);
  // Never reuse a folder: a second meeting with the same title in the same minute would overwrite the first.
  for (let i = 2; existsSync(dir); i++) dir = join(base, `${name}-${i}`);
  mkdirSync(dir, { recursive: true });
  const meta = { title, claude, keepAudio: !!keepAudio, backend, app, startedAt: now.getTime(), done: false, spent: 0, chunks: [] };
  saveMeta(dir, meta);
  saveTranscript(dir, { me: [], them: [], lines: [] });
  return { dir, meta };
}

export const pendingChunks = (meta) => meta.chunks.filter((c) => !c.done).sort((a, b) => a.n - b.n);

// After a crash the recorder can leave a chunk that it closed but never announced. Finishing the meeting adopts it.
export function adoptChunks(dir, meta) {
  const known = new Set(meta.chunks.map((c) => c.n));
  const found = readdirSync(dir).map((f) => /^them-(\d{4})\.m4a$/.exec(f)).filter(Boolean).map((m) => Number(m[1]))
    .filter((n) => !known.has(n) && existsSync(chunkFile(dir, 'me', n))).sort((a, b) => a - b);
  // ponytail: the offset assumes the default 15-second chunks, so a run with ASIDE_CHUNK_SECONDS is off by the difference
  for (const n of found) meta.chunks.push({ n, them: (n - 1) * 15, me: (n - 1) * 15, done: false });
  return found.length;
}

// After the notes are saved the transcribed audio goes, unless the start screen asked to keep it. A chunk that
// failed or was never transcribed keeps its audio for a later try.
export function cleanupAudio(dir, meta) {
  if (meta.keepAudio) return 0;
  const files = meta.chunks.filter((c) => c.done && !c.failed).flatMap((c) => ['them', 'me'].map((t) => chunkFile(dir, t, c.n))).filter((f) => existsSync(f));
  for (const f of files) rmSync(f, { force: true });
  return files.length;
}

const meetingIds = (base) => (existsSync(base) ? readdirSync(base).filter((id) => existsSync(join(base, id, 'meeting.json'))).sort() : []);

// Meetings that are not done: a server that stopped during the call, or notes that failed at the end.
export const unfinishedMeetings = (base) => meetingIds(base).filter((id) => !loadMeta(join(base, id)).done);

export const listMeetings = (base) => meetingIds(base).reverse().map((id) => {
  const m = loadMeta(join(base, id));
  return { id, title: m.title, startedAt: m.startedAt, claude: m.claude, done: m.done };
});
