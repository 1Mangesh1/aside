// Meeting text: merge the two recorded tracks into one transcript, and the prompts that send it to Claude.

const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9']+/g) || []);
// On laptop speakers the microphone also hears the call. A Me sentence that overlaps a Them sentence in time and
// shares most of its words is that echo, not the user speaking. Headphones avoid it entirely. At least 3 shared
// words, so a short real reply such as "I agree." during a longer Them sentence stays.
function isEcho(m, them) {
  const mw = words(m.text);
  return them.some((t) => {
    if (m.start > t.end || m.end < t.start) return false;
    const tw = words(t.text);
    const shared = [...mw].filter((w) => tw.has(w)).length;
    return shared >= 3 && shared / Math.max(1, Math.min(mw.size, tw.size)) >= 0.5;
  });
}

// me and them are Parakeet sentences [{start, end, text}] in seconds from the same start time.
// Sentences are interleaved by start time; consecutive ones from one speaker within 2 s become one line.
export function mergeTranscripts(me, them) {
  const all = [...me.filter((m) => !isEcho(m, them)).map((s) => ({ ...s, speaker: 'Me' })), ...them.map((s) => ({ ...s, speaker: 'Them' }))]
    .filter((s) => s.text).sort((a, b) => a.start - b.start);
  const lines = [];
  for (const s of all) {
    const prev = lines[lines.length - 1];
    if (prev && prev.speaker === s.speaker && s.start - prev.end <= 2) { prev.text += ' ' + s.text; prev.end = s.end; }
    else lines.push({ speaker: s.speaker, start: s.start, end: s.end, text: s.text });
  }
  return lines;
}

// A chunk's sentences carry times from the chunk's own start; this moves them onto the meeting's clock.
export const shiftSentences = (sentences, offset) => sentences.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset }));

const clock = (sec) => { const t = Math.floor(sec); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(s).padStart(2, '0')}`; };

export const transcriptText = (lines) => lines.map((l) => `[${clock(l.start)}] ${l.speaker}: ${l.text}`).join('\n');

export const NOTES_SYSTEM = [
  'You write meeting notes from a two-track speech transcript. "Me" is the person who recorded the call. "Them" is everyone else on the call, on one track, so it can be several people.',
  'Use only what the transcript says. Never invent a name, number, date, decision or task. Speech recognition makes small errors, so read through them, and mark anything you are unsure of with "(unclear)".',
  'Write plain markdown with exactly these sections: "## Summary" (3 to 6 bullets), "## Decisions", "## Action items" (one "- [ ] task (owner, due date)" line each: the owner is a name said on the call, "Me" or "Them", or "unassigned" when nobody took it, and the due date only if one was stated), and "## Open questions". If a section has nothing, write "None stated."',
].join('\n\n');

export const COMPANION_SYSTEM = [
  'You are a quiet companion during a live call. You get the speech transcript so far and one question from "Me", the person who records the call. "Them" is everyone else on the call, on one track.',
  'Answer in two to five short sentences, from the transcript only. Never invent a name, number, date, decision or task. Speech recognition makes small errors, so read through them. If the transcript does not answer the question, say so.',
].join('\n\n');

export const ASK_MEETINGS_SYSTEM = [
  'You answer one question about saved meeting notes. Each meeting comes in its own <meeting title="..." date="..."> block.',
  'Use only these notes, and name the meeting that each fact comes from. If the notes do not answer the question, say so.',
].join('\n\n');

export const companionPrompt = (transcript, question) => `<transcript>\n${transcript || '(nothing said yet)'}\n</transcript>\n\nQuestion from Me: ${question}`;

export function notesFile({ title, date, minutes, notes, lines }) {
  return [`# ${title}`, '', `${date}, about ${minutes} min. Recorded with aside; transcribed on this Mac.`, '', notes.trim(), '', '## Transcript', '', transcriptText(lines), ''].join('\n');
}
