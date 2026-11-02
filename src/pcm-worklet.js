// Runs in a 24 kHz AudioContext, so the browser has already resampled the tab
// audio. Mixes to mono and posts 100 ms chunks of 16-bit PCM.
const CHUNK_SAMPLES = 2400;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels.length === 0) return true;

    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.chunk[this.filled++] = sample * 0x7fff;

      if (this.filled === CHUNK_SAMPLES) {
        const buffer = this.chunk.slice().buffer;
        this.port.postMessage(buffer, [buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
