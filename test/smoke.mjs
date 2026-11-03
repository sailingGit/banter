// Calls the real OpenAI API, and optionally a compatible endpoint, with synthesized speech. This spends a
// small amount of money, so it only runs on demand: npm run smoke
// Keys come from .env.local or the environment and are never printed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { TranscriptAssembler, TurnDetector, sessionConfig, toBase64 } from '../src/asr.js';
import {
  createClient,
  createVisionClient,
  describeError,
  describeScene,
  suggest,
} from '../src/suggest.js';

const SPEECH = process.env.SMOKE_TEXT ?? 'Hi there, where are you from, and what do you do for fun?';
const VOICE = process.env.SMOKE_VOICE ?? 'Samantha';
const CHUNK_BYTES = 4800;
const BASE_URL = 'https://api.openai.com/v1';

const openaiKey = process.env.OPENAI_API_KEY;
const custom = {
  replyProvider: 'custom',
  customBaseUrl: process.env.CHAT_BASE_URL,
  customKey: process.env.CHAT_API_KEY,
  customModel: process.env.CHAT_MODEL,
  customFormat: process.env.CHAT_FORMAT,
};
const results = [];

function report(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

function synthesizePcm() {
  const dir = mkdtempSync(join(tmpdir(), 'banter-smoke-'));
  try {
    const aiff = join(dir, 'speech.aiff');
    const raw = join(dir, 'speech.pcm');
    execFileSync('say', ['-v', VOICE, '-o', aiff, SPEECH]);
    execFileSync('afconvert', ['-f', 'caff', '-d', 'LEI16@24000', '-c', '1', aiff, `${raw}.caf`]);
    const caf = readFileSync(`${raw}.caf`);
    // CAF stores samples after a 'data' chunk header plus a 4-byte edit count.
    return caf.subarray(caf.indexOf('data') + 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mintSecret(session) {
  const response = await fetch(`${BASE_URL}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message}`);
  return body.value;
}

async function transcribe(pcm, secret, session) {
  const socket = new WebSocket(
    `${BASE_URL.replace(/^http/, 'ws')}/realtime?intent=transcription`,
    ['realtime', `openai-insecure-api-key.${secret}`],
    { origin: 'chrome-extension://smoketest' },
  );
  const assembler = new TranscriptAssembler();
  const turns = new TurnDetector();
  const silence = Buffer.alloc(CHUNK_BYTES);
  let firstDeltaMs = null;
  let commitAt = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no completed transcript within 30 s'));
    }, 30_000);

    const sendAudio = async () => {
      const chunks = [];
      for (let i = 0; i + CHUNK_BYTES <= pcm.length; i += CHUNK_BYTES) {
        chunks.push(pcm.subarray(i, i + CHUNK_BYTES));
      }
      chunks.push(...Array(12).fill(silence));

      for (const chunk of chunks) {
        if (socket.readyState !== WebSocket.OPEN || commitAt) return;
        socket.send(
          JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(chunk) }),
        );
        const samples = new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));
        if (turns.push(samples).commit) {
          commitAt = performance.now();
          socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          return;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      if (!commitAt) reject(new Error('the turn detector never ended the turn'));
    };

    const startedAt = performance.now();
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'session.update', session }));
      sendAudio();
    });
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`handshake rejected: ${res.statusCode}`));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('message', (data) => {
      const event = JSON.parse(data);
      const { interim, utterance, error } = assembler.push(event);
      if (interim && firstDeltaMs === null) firstDeltaMs = performance.now() - startedAt;
      if (error) {
        clearTimeout(timer);
        socket.close();
        reject(new Error(error));
      }
      if (utterance) {
        clearTimeout(timer);
        socket.close();
        resolve({
          utterance,
          firstDeltaMs,
          afterCommitMs: performance.now() - commitAt,
        });
      }
    });
  });
}

async function checkReply(settings, utterance) {
  const client = createClient(settings);
  const startedAt = performance.now();
  try {
    const { reply } = await suggest(client, [{ speaker: 'them', text: utterance }]);
    const ms = Math.round(performance.now() - startedAt);
    const shaped =
      reply.translation &&
      reply.suggestions?.length === 3 &&
      reply.suggestions.every((item) => item.text && item.zh);
    report(`${client.name} reply (${client.model})`, Boolean(shaped), `${ms} ms`);
    console.log(JSON.stringify(reply, null, 2));
  } catch (err) {
    report(`${client.name} reply (${client.model})`, false, describeError(err));
  }
}

async function checkScene() {
  const image = `data:image/jpeg;base64,${readFileSync('test/fixtures/scene.jpg').toString('base64')}`;
  const client = createVisionClient({ openaiKey });
  const startedAt = performance.now();
  try {
    const { reply } = await describeScene(client, image, 'en');
    const ms = Math.round(performance.now() - startedAt);
    report(`scene (${client.model})`, Boolean(reply.scene && reply.suggestions.length === 3), `${ms} ms`);
    console.log(JSON.stringify(reply, null, 2));
  } catch (err) {
    report(`scene (${client.model})`, false, describeError(err));
  }
}

let utterance = SPEECH;
if (openaiKey) {
  const session = sessionConfig();
  try {
    const secret = await mintSecret(session);
    report('client secret', secret.startsWith('ek_'));
    const pcm = synthesizePcm();
    console.log(`speech: ${(pcm.length / 48000).toFixed(1)} s`);
    const heard = await transcribe(pcm, secret, session);
    utterance = heard.utterance;
    report(
      'realtime transcription',
      true,
      `first text ${Math.round(heard.firstDeltaMs)} ms, final ${Math.round(heard.afterCommitMs)} ms after commit`,
    );
    console.log(`heard: ${utterance}`);
  } catch (err) {
    report('realtime transcription', false, err.message);
  }
  await checkReply({ openaiKey }, utterance);
  await checkScene();
} else {
  console.log('SKIP  OpenAI: OPENAI_API_KEY is not set');
}

if (custom.customBaseUrl && custom.customModel) await checkReply(custom, utterance);
else console.log('SKIP  compatible endpoint: CHAT_BASE_URL or CHAT_MODEL is not set');

process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);
