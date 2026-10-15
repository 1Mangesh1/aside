// Turns the recorder's closed chunks into a growing transcript, one chunk at a time, in order. The meeting's meta
// lives in memory and is saved after each chunk, so a chunk that arrives during a run is taken by the same run.
import { mergeTranscripts, shiftSentences } from './notes.mjs';
import { chunkFile, saveMeta, loadTranscript, saveTranscript, pendingChunks } from './meeting.mjs';

export function makeTranscriber({ meeting, getAsr, onLines }) {
  let running = null;
  // Resolves true when no chunk is left, false when the worker is down or a chunk failed and will be tried again.
  async function drain() {
    for (let c = pendingChunks(meeting.meta)[0]; c; c = pendingChunks(meeting.meta)[0]) {
      const asr = getAsr();
      if (!asr?.ready) return false;
      try {
        const [me, them] = await Promise.allSettled(['me', 'them'].map((track) => asr.transcribe(chunkFile(meeting.dir, track, c.n), { sentences: true })));
        if (me.status === 'rejected' && them.status === 'rejected') throw them.reason;
        // One track can fail alone, for example a last chunk too short to decode; the other track still counts.
        for (const r of [me, them]) if (r.status === 'rejected') console.error(`Chunk ${c.n}: one track failed: ${r.reason.message}`);
        const t = loadTranscript(meeting.dir);
        t.me.push(...shiftSentences(me.value?.sentences || [], c.me));
        t.them.push(...shiftSentences(them.value?.sentences || [], c.them));
        t.lines = mergeTranscripts(t.me, t.them);
        saveTranscript(meeting.dir, t);
        onLines(t.lines);
      } catch (e) {
        c.tries = (c.tries || 0) + 1;
        console.error(`Chunk ${c.n} failed (${c.tries} of 3): ${e.message}`);
        saveMeta(meeting.dir, meeting.meta);
        if (c.tries < 3) return false;
        c.failed = true; // ponytail: a chunk that fails 3 times is skipped (its audio is kept), so one bad file cannot stall the meeting
      }
      c.done = true;
      saveMeta(meeting.dir, meeting.meta);
    }
    return true;
  }
  // Chunk callbacks and the server's timer start runs without waiting, so a run never rejects.
  const run = () => (running ||= drain()
    .catch((e) => { console.error(`Transcription paused: ${e.message}`); return false; })
    .finally(() => { running = null; }));
  return { run };
}
