import { OpenAITranscriber, parseLanguages, sentMinutes, transcriptionCost } from './asr.js';
import {
  createClient,
  createVisionClient,
  describeError,
  describeScene,
  isAbort,
  replyCost,
  suggest,
} from './suggest.js';
import { resolveNativeLanguage, translator, uiLanguage } from './i18n.js';

const DEFAULT_IDLE_STOP_MS = 3 * 60 * 1000;
const TICK_MS = 5000;

// All conversation state lives here in memory and is gone when capture stops.
let session = null;

function toOverlay(payload) {
  chrome.runtime.sendMessage({ target: 'background', type: 'overlay', tabId: session.tabId, payload });
}

function updateMeter() {
  const minutes = Math.floor((Date.now() - session.startedAt) / 60_000);
  const cost = transcriptionCost(session.asr.sentFrames) + session.replyCost;
  const speech = sentMinutes(session.asr.sentFrames).toFixed(1);
  // Without a reply price the estimate only covers transcription.
  const key = session.client.inputPrice ? 'meter' : 'meterPartial';
  toOverlay({ type: 'meter', text: session.t(key, { minutes, speech, cost: cost.toFixed(2) }) });
}

function tick() {
  if (Date.now() - session.lastHeardAt >= session.idleStopMs) {
    const minutes = Math.round(session.idleStopMs / 60_000);
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'stop',
      notice: session.t('idleStop', { minutes }),
    });
    return;
  }
  updateMeter();
}

function settingsTranslator(settings) {
  return translator(uiLanguage(resolveNativeLanguage(settings.nativeLanguage)));
}

async function start({ streamId, tabId, settings }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // Capturing a tab mutes it, so route the audio back to the speakers. This
  // uses a separate context because the 24 kHz one would degrade playback.
  const playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);

  const capture = new AudioContext({ sampleRate: 24000 });
  await capture.audioWorklet.addModule('pcm-worklet.js');
  const worklet = new AudioWorkletNode(capture, 'pcm-processor');
  capture.createMediaStreamSource(stream).connect(worklet);
  worklet.connect(capture.destination);

  session = {
    t: settingsTranslator(settings),
    tabId,
    turns: [],
    pending: null,
    language: null,
    client: createClient(settings),
    visionClient: createVisionClient(settings),
    replyCost: 0,
    startedAt: Date.now(),
    lastHeardAt: Date.now(),
    idleStopMs: settings.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
  };
  session.asr = new OpenAITranscriber({
    apiKey: settings.openaiKey,
    baseUrl: settings.apiBaseUrl,
    languages: parseLanguages(settings.languages),
    t: session.t,
    onInterim: (text) => {
      session.lastHeardAt = Date.now();
      toOverlay({ type: 'interim', text });
    },
    onUtterance: (text) => {
      session.lastHeardAt = Date.now();
      session.turns.push({ speaker: 'them', text });
      toOverlay({ type: 'utterance', text });
      generate();
    },
    onSending: (active) => toOverlay({ type: 'billing', active }),
    onError: (text) => toOverlay({ type: 'status', level: 'error', text }),
  });
  worklet.port.onmessage = (event) => session.asr.send(event.data);

  stream.getAudioTracks()[0].addEventListener('ended', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
  });

  setInterval(tick, Math.min(TICK_MS, session.idleStopMs));
  generate();
}

async function respond(client, request, show) {
  // Anything newer makes a reply still in flight stale.
  session.pending?.abort();
  const pending = new AbortController();
  session.pending = pending;
  const startedAt = performance.now();
  toOverlay({ type: 'status', text: session.t('generating') });

  try {
    const { reply, usage } = await request(pending.signal);
    session.replyCost += replyCost(client, usage);
    if (pending.signal.aborted) return;
    show(reply, Math.round(performance.now() - startedAt));
    updateMeter();
  } catch (err) {
    if (isAbort(err)) return;
    console.error('[banter] request failed', err);
    toOverlay({ type: 'status', level: 'error', text: describeError(err, session.t) });
  }
}

function generate() {
  const { client, turns } = session;
  return respond(
    client,
    (signal) => suggest(client, turns, { signal }),
    (reply, ms) => {
      session.language = reply.language;
      toOverlay({ type: 'suggestions', ...reply, ms });
    },
  );
}

function look(image) {
  const client = session.visionClient;
  const language = session.language ?? client.defaultLanguage;
  return respond(
    client,
    (signal) => describeScene(client, image, language, { signal }),
    ({ scene, suggestions }, ms) => {
      if (suggestions.length === 0) {
        toOverlay({ type: 'status', text: session.t('noTopics') });
        return;
      }
      toOverlay({
        type: 'suggestions',
        language,
        translation: session.t('scene', { scene }),
        ipa: '',
        suggestions,
        ms,
      });
    },
  );
}

function reset() {
  session.turns = [];
  session.language = null;
  toOverlay({ type: 'reset' });
  generate();
}

// The overlay dies with its page. Capture would otherwise keep going, and keep
// billing, with nothing on screen to show for it or to stop it.
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {
    chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg).catch((err) => {
      console.error('[banter] start failed', err);
      const text = settingsTranslator(msg.settings)('startFailed', { error: err.message });
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'overlay',
        tabId: msg.tabId,
        payload: { type: 'status', level: 'error', text },
      });
    });
    return;
  }
  if (!session) return;
  if (msg.type === 'reset') reset();
  if (msg.type === 'regenerate') generate();
  if (msg.type === 'look') look(msg.image);
  if (msg.type === 'picked') session.turns.push({ speaker: 'me', text: msg.text });
});
