import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranscripts, transcriptText, shiftSentences, companionPrompt } from '../lib/notes.mjs';

test('mergeTranscripts interleaves by time and joins a speaker\'s close sentences', () => {
  const me = [{ start: 0.5, end: 2, text: 'Hi, thanks for joining.' }, { start: 2.8, end: 4, text: 'Shall we start?' }, { start: 20, end: 22, text: 'Sounds good.' }];
  const them = [{ start: 5, end: 9, text: 'Yes. First, the release date.' }, { start: 9.5, end: 12, text: 'We ship on Friday.' }];
  const lines = mergeTranscripts(me, them);
  assert.deepEqual(lines.map((l) => [l.speaker, l.text]), [
    ['Me', 'Hi, thanks for joining. Shall we start?'],
    ['Them', 'Yes. First, the release date. We ship on Friday.'],
    ['Me', 'Sounds good.'],
  ]);
});

test('transcriptText stamps each line with minutes and seconds, and hours past one hour', () => {
  const out = transcriptText([{ speaker: 'Me', start: 65.4, text: 'One.' }, { speaker: 'Them', start: 3725, text: 'Two.' }]);
  assert.equal(out, '[1:05] Me: One.\n[1:02:05] Them: Two.');
});

test('mergeTranscripts drops a Me line that is the speakers echoing Them into the microphone', () => {
  const them = [{ start: 3.76, end: 7.84, text: 'This is the call audio track. We ship the release on Friday.' }];
  const me = [{ start: 3.2, end: 8.24, text: 'This is the car on the track, which is the release on Friday.' }, { start: 9, end: 10, text: 'Great, thanks.' }];
  const lines = mergeTranscripts(me, them);
  assert.deepEqual(lines.map((l) => [l.speaker, l.text]), [['Them', 'This is the call audio track. We ship the release on Friday.'], ['Me', 'Great, thanks.']]);
});

test('a short real reply during a longer Them sentence is not taken for echo', () => {
  const them = [{ start: 3, end: 7, text: 'I think we should ship the release on Friday.' }];
  const me = [{ start: 5, end: 6, text: 'I agree.' }, { start: 6.2, end: 6.9, text: 'Yes, Friday.' }];
  assert.deepEqual(mergeTranscripts(me, them).map((l) => [l.speaker, l.text]), [['Them', 'I think we should ship the release on Friday.'], ['Me', 'I agree. Yes, Friday.']]);
});

test('shiftSentences moves a chunk\'s sentences onto the meeting clock', () => {
  assert.deepEqual(shiftSentences([{ start: 1.5, end: 4, text: 'We ship on Friday.' }], 15.25), [{ start: 16.75, end: 19.25, text: 'We ship on Friday.' }]);
});

test('companionPrompt wraps the transcript and says when nothing was said yet', () => {
  assert.equal(companionPrompt('[0:04] Them: We ship on Friday.', 'When do we ship?'), '<transcript>\n[0:04] Them: We ship on Friday.\n</transcript>\n\nQuestion from Me: When do we ship?');
  assert.equal(companionPrompt('', 'Did they start?'), '<transcript>\n(nothing said yet)\n</transcript>\n\nQuestion from Me: Did they start?');
});
