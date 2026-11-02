import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpenAITranscriber,
  TranscriptAssembler,
  TurnDetector,
  parseLanguages,
  sessionConfig,
  toBase64,
  transcriptionCost,
} from '../src/asr.js';

const FRAME = 2400;
const quiet = () => new Int16Array(FRAME);
const loud = () => new Int16Array(FRAME).fill(8000);

function feed(detector, frames) {
  return frames.filter((frame) => detector.push(frame).commit).length;
}

// Builds a transcriber around a fake socket, skipping the network connection.
function gatedTranscriber() {
  const sent = [];
  const sending = [];
  const transcriber = Object.create(OpenAITranscriber.prototype);
  Object.assign(transcriber, {
    socket: { readyState: WebSocket.OPEN, send: (data) => sent.push(JSON.parse(data).type) },
    turns: new TurnDetector(),
    preRoll: [],
    sentFrames: 0,
    sending: false,
    onSending: (active) => sending.push(active),
  });
  return { transcriber, sent, sending };
}

function appends(sent) {
  return sent.filter((type) => type === 'input_audio_buffer.append').length;
}

const repeat = (make, count) => Array.from({ length: count }, make);

test('session asks for live transcription of 24 kHz PCM without server VAD', () => {
  const { audio, type } = sessionConfig();
  assert.equal(type, 'transcription');
  assert.deepEqual(audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(audio.input.transcription.languages, undefined);
  assert.equal(audio.input.turn_detection, null);
});

test('language hints are parsed and passed through', () => {
  assert.deepEqual(parseLanguages(' ru, es，en '), ['ru', 'es', 'en']);
  assert.deepEqual(parseLanguages(undefined), []);
  assert.deepEqual(sessionConfig(['ru']).audio.input.transcription.languages, ['ru']);
});

test('base64 encodes raw PCM bytes', () => {
  assert.equal(toBase64(new Int16Array([1, 2]).buffer), Buffer.from([1, 0, 2, 0]).toString('base64'));
});

test('a turn ends once after speech followed by silence', () => {
  const detector = new TurnDetector();
  assert.equal(feed(detector, [...repeat(loud, 10), ...repeat(quiet, 5)]), 0);
  assert.equal(feed(detector, repeat(quiet, 20)), 1);
});

test('a short pause does not end the turn', () => {
  const detector = new TurnDetector();
  const frames = [...repeat(loud, 5), ...repeat(quiet, 4), ...repeat(loud, 5), ...repeat(quiet, 4)];
  assert.equal(feed(detector, frames), 0);
});

test('a noise blip is not committed', () => {
  const detector = new TurnDetector();
  assert.equal(feed(detector, [...repeat(loud, 2), ...repeat(quiet, 10)]), 0);
});

test('nonstop speech still closes a turn', () => {
  const detector = new TurnDetector();
  assert.equal(feed(detector, repeat(loud, 300)), 2);
});

test('steady background noise raises the threshold', () => {
  const detector = new TurnDetector();
  const hum = () => new Int16Array(FRAME).fill(150);
  feed(detector, repeat(hum, 200));
  const speech = () => new Int16Array(FRAME).fill(6000);
  assert.equal(feed(detector, [...repeat(speech, 5), ...repeat(hum, 8)]), 1);
});

test('silence is never sent', () => {
  const { transcriber, sent } = gatedTranscriber();
  for (let i = 0; i < 100; i++) transcriber.send(quiet().buffer);
  assert.deepEqual(sent, []);
  assert.equal(transcriber.sentFrames, 0);
});

test('a turn sends the pre-roll, the speech and the closing silence, then commits', () => {
  const { transcriber, sent } = gatedTranscriber();
  for (let i = 0; i < 20; i++) transcriber.send(quiet().buffer);
  for (let i = 0; i < 10; i++) transcriber.send(loud().buffer);
  for (let i = 0; i < 20; i++) transcriber.send(quiet().buffer);

  assert.equal(appends(sent), 3 + 10 + 6);
  assert.equal(sent.at(-1), 'input_audio_buffer.commit');
  assert.equal(transcriber.sentFrames, 19);
});

test('the sending state changes only when a turn starts and ends', () => {
  const { transcriber, sending } = gatedTranscriber();
  for (let i = 0; i < 20; i++) transcriber.send(quiet().buffer);
  assert.deepEqual(sending, []);
  for (let i = 0; i < 10; i++) transcriber.send(loud().buffer);
  assert.deepEqual(sending, [true]);
  for (let i = 0; i < 20; i++) transcriber.send(quiet().buffer);
  assert.deepEqual(sending, [true, false]);
});

test('transcription cost follows the audio actually sent', () => {
  assert.equal(transcriptionCost(0), 0);
  assert.ok(Math.abs(transcriptionCost(600) - 0.017) < 1e-9);
});

test('deltas accumulate per item and completion yields the utterance', () => {
  const assembler = new TranscriptAssembler();
  const delta = (delta) => ({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'a',
    delta,
  });
  assert.equal(assembler.push(delta('hola')).interim, 'hola');
  assert.equal(assembler.push(delta(' de donde')).interim, 'hola de donde');
  const done = assembler.push({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'a',
    transcript: ' hola de donde eres ',
  });
  assert.equal(done.utterance, 'hola de donde eres');
  assert.equal(assembler.push(delta('nuevo')).interim, 'nuevo');
});

test('empty transcripts and an empty commit stay silent', () => {
  const assembler = new TranscriptAssembler();
  assert.deepEqual(
    assembler.push({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '  ',
    }),
    {},
  );
  assert.deepEqual(
    assembler.push({ type: 'error', error: { code: 'input_audio_buffer_commit_empty' } }),
    {},
  );
});

test('server errors are surfaced', () => {
  const assembler = new TranscriptAssembler();
  assert.equal(assembler.push({ type: 'error', error: { message: 'boom' } }).error, 'boom');
  assert.equal(
    assembler.push({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'a',
      error: { message: 'bad audio' },
    }).error,
    'bad audio',
  );
});
