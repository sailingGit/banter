import { translator } from './i18n.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_RECONNECTS = 5;

// Frames are the 100 ms chunks from pcm-worklet.js.
const MIN_LEVEL = 0.008;
const NOISE_RATIO = 3;
const MIN_SPEECH_FRAMES = 3;
const END_SILENCE_FRAMES = 6;
const MAX_SPEECH_FRAMES = 150;
const PRE_ROLL_FRAMES = 3;

const TRANSCRIBE_DOLLARS_PER_MINUTE = 0.017;
const FRAMES_PER_MINUTE = 600;

function rms(samples) {
  let sum = 0;
  for (const sample of samples) sum += (sample / 0x8000) ** 2;
  return Math.sqrt(sum / samples.length);
}

// gpt-live-transcribe has no server-side turn detection, so the end of each
// turn is found here. Call audio arrives noise-suppressed, which keeps a simple
// level check reliable; in a loud room MAX_SPEECH_FRAMES still closes the turn.
export class TurnDetector {
  constructor() {
    this.noise = 0;
    this.reset();
  }

  reset() {
    this.speech = 0;
    this.silence = 0;
  }

  // Returns whether this frame belongs to a turn and should be sent, and
  // whether it ends a turn worth transcribing.
  push(samples) {
    const level = rms(samples);
    if (level >= Math.max(MIN_LEVEL, this.noise * NOISE_RATIO)) {
      this.speech++;
      this.silence = 0;
    } else {
      this.noise += (level - this.noise) * 0.05;
      if (this.speech > 0) this.silence++;
    }

    const send = this.speech > 0;
    const ended = this.silence >= END_SILENCE_FRAMES || this.speech >= MAX_SPEECH_FRAMES;
    if (!ended) return { send, commit: false };
    const commit = this.speech >= MIN_SPEECH_FRAMES;
    this.reset();
    return { send, commit };
  }
}

export function sentMinutes(sentFrames) {
  return sentFrames / FRAMES_PER_MINUTE;
}

export function transcriptionCost(sentFrames) {
  return sentMinutes(sentFrames) * TRANSCRIBE_DOLLARS_PER_MINUTE;
}

export function sessionConfig(languages) {
  const transcription = { model: 'gpt-live-transcribe', delay: 'low' };
  if (languages?.length) transcription.languages = languages;
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription,
        turn_detection: null,
      },
    },
  };
}

export function parseLanguages(value) {
  return (value ?? '').split(/[\s,，]+/).filter(Boolean);
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Turns Realtime transcription events into live text plus finished utterances.
export class TranscriptAssembler {
  constructor(t = translator('en')) {
    this.t = t;
    this.partials = new Map();
  }

  // Returns { interim?, utterance?, error? } for one server event.
  push(event) {
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const text = (this.partials.get(event.item_id) ?? '') + event.delta;
        this.partials.set(event.item_id, text);
        return { interim: text.trim() };
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.partials.delete(event.item_id);
        const utterance = event.transcript?.trim();
        return utterance ? { utterance } : {};
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.partials.delete(event.item_id);
        return { error: event.error?.message ?? this.t('asr.failed') };
      case 'error':
        // A noise burst can be committed with too little audio; nothing is lost.
        if (event.error?.code === 'input_audio_buffer_commit_empty') return {};
        return { error: event.error?.message ?? this.t('asr.error') };
      default:
        return {};
    }
  }
}

export class OpenAITranscriber {
  constructor({ apiKey, baseUrl, languages, t, onInterim, onUtterance, onSending, onError }) {
    Object.assign(this, { apiKey, t, onInterim, onUtterance, onSending, onError });
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.session = sessionConfig(languages);
    this.assembler = new TranscriptAssembler(t);
    this.turns = new TurnDetector();
    this.preRoll = [];
    this.sentFrames = 0;
    this.sending = false;
    this.closed = false;
    this.reconnects = 0;
    this.connect();
  }

  // Exchanges the long-lived key for a short-lived one, so the real key never
  // appears in the WebSocket handshake.
  async mintClientSecret() {
    const response = await fetch(`${this.baseUrl}/realtime/client_secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: this.session }),
    });
    if (response.status === 401) {
      this.fail(this.t('error.badKey', { provider: 'OpenAI' }));
      return null;
    }
    if (!response.ok) throw new Error(`client secret request failed: ${response.status}`);
    return (await response.json()).value;
  }

  async connect() {
    let secret;
    try {
      secret = await this.mintClientSecret();
    } catch (err) {
      console.error('[banter] client secret failed', err);
      this.retry();
      return;
    }
    if (!secret || this.closed) return;

    const url = `${this.baseUrl.replace(/^http/, 'ws')}/realtime?intent=transcription`;
    const socket = new WebSocket(url, ['realtime', `openai-insecure-api-key.${secret}`]);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnects = 0;
      socket.send(JSON.stringify({ type: 'session.update', session: this.session }));
    };
    socket.onmessage = (event) => this.handle(JSON.parse(event.data));
    socket.onclose = () => {
      this.setSending(false);
      if (!this.closed) this.retry();
    };
  }

  retry() {
    if (this.closed) return;
    if (this.reconnects++ >= MAX_RECONNECTS) {
      this.fail(this.t('asr.unreachable'));
      return;
    }
    setTimeout(() => this.connect(), 1000 * this.reconnects);
  }

  fail(text) {
    this.closed = true;
    this.onError(text);
  }

  setSending(active) {
    if (active === this.sending) return;
    this.sending = active;
    this.onSending(active);
  }

  handle(event) {
    const { interim, utterance, error } = this.assembler.push(event);
    if (interim) this.onInterim(interim);
    if (utterance) this.onUtterance(utterance);
    if (error) this.onError(error);
  }

  // Transcription is billed by the minute, so silence between turns stays
  // local. The last few quiet frames go out first so word onsets aren't clipped.
  send(pcm) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const { send, commit } = this.turns.push(new Int16Array(pcm));
    this.setSending(send);
    this.preRoll.push(pcm);
    if (!send) {
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      return;
    }

    for (const frame of this.preRoll) {
      this.socket.send(
        JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(frame) }),
      );
      this.sentFrames++;
    }
    this.preRoll = [];
    if (commit) this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
