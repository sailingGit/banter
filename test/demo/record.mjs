// Records the README demo: the built extension on a mock video chat page,
// driven by scripted transcripts and replies. Everything shown is demo data.
// Usage: node test/demo/record.mjs zh|en, or npm run demo for both (needs ffmpeg).
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translator } from '../../src/i18n.js';
import {
  clickPanelButton,
  completed,
  delta,
  launchExtension,
  panelText,
  startMocks,
  waitFor,
} from '../e2e/harness.mjs';

const OUT = 'docs/images';
const SIZE = { width: 1280, height: 600 };

const demoPage = (labels) => `<!doctype html><meta charset="utf-8"><title>demo</title>
<style>
  body { margin: 0; height: 100vh; background: #15171c; font: 14px -apple-system, "PingFang SC", sans-serif; }
  .stage { position: absolute; left: 24px; top: 24px; width: 880px; height: 495px; border-radius: 14px; overflow: hidden; background: #000; }
  #remote-video { width: 100%; height: 100%; object-fit: cover; }
  #local-video { position: absolute; right: 14px; bottom: 14px; width: 192px; height: 108px; border-radius: 8px; border: 2px solid #2a2d35; object-fit: cover; }
  .badge { position: absolute; left: 14px; bottom: 14px; padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,.55); color: #e8e8e8; font-size: 12px; }
  .bar { position: absolute; left: 24px; top: 535px; width: 880px; display: flex; gap: 10px; }
  .bar div { padding: 10px 18px; border-radius: 10px; background: #23262e; color: #9aa0ac; }
  .bar .next { background: #2f6fed; color: #fff; }
</style>
<div class="stage">
  <video id="remote-video" muted autoplay></video>
  <video id="local-video" muted autoplay></video>
  <div class="badge">${labels.badge}</div>
</div>
<div class="bar"><div class="next">${labels.next}</div><div>${labels.stop}</div><div style="flex:1">${labels.message}</div></div>
<script>
  const stream = (draw) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    setInterval(() => draw(context, performance.now() / 1000), 66);
    return canvas.captureStream(15);
  };
  const scene = new Image();
  scene.src = '/scene.jpg';
  document.getElementById('remote-video').srcObject = stream((context, t) => {
    const zoom = 1.04 + 0.02 * Math.sin(t / 2);
    context.drawImage(scene, 640 - 640 * zoom, 360 - 360 * zoom, 1280 * zoom, 720 * zoom);
  });
  document.getElementById('local-video').srcObject = stream((context) => {
    context.fillStyle = '#3a3f4b';
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#c9ced8';
    context.font = '160px sans-serif';
    context.textAlign = 'center';
    context.fillText('${labels.you}', 640, 420);
  });
  let osc;
  window.talk = () => {
    const ctx = new AudioContext();
    osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
  };
  window.hush = () => osc.stop();
</script>`;

// A Chinese speaker practising English, and an English speaker practising Spanish.
const DEMOS = {
  zh: {
    suffix: '',
    labels: { badge: '演示数据 · 并非真实聊天', next: '下一位', stop: '停止', message: '发消息…', you: '你' },
    settings: { nativeLanguage: 'zh-CN', languages: 'en', profile: '上海程序员，喜欢跑步和吉他' },
    heard: "Hey! Where are you from? It's pretty late here.",
    opener: {
      language: 'en',
      translation: '',
      ipa: '',
      suggestions: [
        { style: 'relaxed', text: "Hey, how's your day going?", ipa: '/heɪ haʊz jʊr deɪ ˈɡoʊɪŋ/', meaning: '嗨，今天过得怎么样？' },
        { style: 'playful', text: "Finally, someone who's awake!", ipa: '/ˈfaɪnəli ˈsʌmˌwʌn huz əˈweɪk/', meaning: '终于遇到一个醒着的人了！' },
        { style: 'follow-up', text: 'Where are you calling from?', ipa: '/wɛr ɑr ju ˈkɔlɪŋ frʌm/', meaning: '你在哪儿呀？' },
      ],
    },
    reply: {
      language: 'en',
      translation: '嘿！你是哪里人？我这边挺晚了。',
      ipa: '/heɪ wɛr ɑr ju frʌm ɪts ˈprɪti leɪt hɪr/',
      suggestions: [
        { style: 'relaxed', text: "I'm from Shanghai, it's just after lunch here.", ipa: '/aɪm frʌm ˌʃæŋˈhaɪ ɪts dʒʌst ˈæftɚ lʌntʃ hɪr/', meaning: '我是上海的，我这边刚吃完午饭。' },
        { style: 'playful', text: "Late night? Then I'm your bedtime story.", ipa: '/leɪt naɪt ðɛn aɪm jʊr ˈbɛdˌtaɪm ˈstɔri/', meaning: '这么晚？那我就是你的睡前故事了。' },
        { style: 'follow-up', text: 'What keeps you up so late?', ipa: '/wʌt kips ju ʌp soʊ leɪt/', meaning: '什么让你熬这么晚？' },
      ],
    },
    scene: {
      scene: '墙上有一张东京马拉松海报，旁边靠着一把吉他',
      suggestions: [
        { style: 'relaxed', text: 'Wait, did you run the Tokyo Marathon?', ipa: '/weɪt dɪd ju rʌn ðə ˈtoʊkioʊ ˈmɛrəˌθɑn/', meaning: '等等，你跑过东京马拉松？' },
        { style: 'playful', text: 'Runner and guitarist? Leave some talent for us.', ipa: '/ˈrʌnɚ ænd ɡɪˈtɑrɪst liv sʌm ˈtælənt fɔr ʌs/', meaning: '又跑步又弹吉他？给别人留点才艺吧。' },
        { style: 'follow-up', text: 'Do you play that guitar, or is it decoration?', ipa: '/du ju pleɪ ðæt ɡɪˈtɑr ɔr ɪz ɪt ˌdɛkəˈreɪʃən/', meaning: '那把吉他你会弹吗，还是摆设？' },
      ],
    },
  },
  en: {
    suffix: '-en',
    labels: { badge: 'Demo data · not a real chat', next: 'Next', stop: 'Stop', message: 'Type a message…', you: 'You' },
    settings: { nativeLanguage: 'en', languages: 'es', profile: 'Software engineer in Toronto, into running and guitar' },
    heard: '¡Hola! ¿De dónde eres? Aquí ya es muy tarde.',
    opener: {
      language: 'es',
      translation: '',
      ipa: '',
      suggestions: [
        { style: 'relaxed', text: '¡Hola! ¿Qué tal tu día?', ipa: '', meaning: "Hi! How's your day going?" },
        { style: 'playful', text: '¡Por fin alguien despierto!', ipa: '', meaning: "Finally, someone who's awake!" },
        { style: 'follow-up', text: '¿Desde dónde me hablas?', ipa: '', meaning: 'Where are you calling from?' },
      ],
    },
    reply: {
      language: 'es',
      translation: "Hi! Where are you from? It's already really late here.",
      ipa: '',
      suggestions: [
        { style: 'relaxed', text: 'Soy de Toronto, aquí es la hora del almuerzo.', ipa: '', meaning: "I'm from Toronto, it's lunchtime here." },
        { style: 'playful', text: '¿Tan tarde? Entonces soy tu cuento para dormir.', ipa: '', meaning: "That late? Then I'm your bedtime story." },
        { style: 'follow-up', text: '¿Y qué te tiene despierto a estas horas?', ipa: '', meaning: 'So what keeps you up this late?' },
      ],
    },
    scene: {
      scene: 'A Tokyo Marathon poster on the wall, with a guitar leaning beside it',
      suggestions: [
        { style: 'relaxed', text: 'Espera, ¿corriste el maratón de Tokio?', ipa: '', meaning: 'Wait, did you run the Tokyo Marathon?' },
        { style: 'playful', text: '¿Corredor y guitarrista? Deja talento para los demás.', ipa: '', meaning: 'Runner and guitarist? Leave some talent for the rest of us.' },
        { style: 'follow-up', text: '¿Tocas esa guitarra o es de decoración?', ipa: '', meaning: 'Do you play that guitar, or is it just decoration?' },
      ],
    },
  },
};

const language = process.argv[2] ?? 'zh';
const demo = DEMOS[language];
const t = translator(language);
const out = (name) => join(OUT, `${name}${demo.suffix}.png`);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Screenshots in a loop, timed so the GIF plays at real speed.
function recordFrames(page, dir) {
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, at: performance.now() });
    }
  })();
  return async () => {
    running = false;
    await loop;
    return frames;
  };
}

async function writeGif(frames, dir, out) {
  const list = frames.map(({ file, at }, i) => {
    const next = frames[i + 1]?.at ?? at + 100;
    return `file '${file}'\nduration ${((next - at) / 1000).toFixed(3)}`;
  });
  list.push(`file '${frames.at(-1).file}'`);
  const listFile = join(dir, 'frames.txt');
  await writeFile(listFile, list.join('\n'));
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    out,
  ]);
}

const mock = await startMocks({
  page: demoPage(demo.labels),
  files: { '/scene.jpg': { type: 'image/jpeg', body: await readFile('test/fixtures/scene.jpg') } },
  delayMs: 900,
  respond: (request) => {
    const content = request.body.messages[1].content;
    if (Array.isArray(content)) return demo.scene;
    return content.includes('<transcript>') ? demo.reply : demo.opener;
  },
});
const frameDir = await mkdtemp(join(tmpdir(), 'banter-demo-'));
const extension = await launchExtension();
const { context, worker } = extension;

try {
  await worker.evaluate(
    ({ apiBaseUrl, settings }) =>
      chrome.storage.local.set({ openaiKey: 'sk-demo', apiBaseUrl, ...settings }),
    { apiBaseUrl: `http://localhost:${mock.port}/v1`, settings: demo.settings },
  );

  const tab = await context.newPage();
  await tab.setViewportSize(SIZE);
  await tab.goto(`http://localhost:${mock.port}/`);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://localhost:${mock.port}`,
  });
  const panel = () => panelText(context, tab);
  const stopRecording = recordFrames(tab, frameDir);
  await pause(800);

  await extension.toggle();
  await waitFor(async () => (await panel()).includes(demo.opener.suggestions[1].text), 'openers');
  await waitFor(() => mock.socket, 'the Realtime connection');
  await pause(2200);

  await tab.evaluate(() => window.talk());
  await waitFor(async () => (await panel()).includes(t('billingOn')), 'the billing indicator');
  let heard = '';
  for (const word of demo.heard.split(' ')) {
    heard += `${heard ? ' ' : ''}${word}`;
    mock.send(delta(`${heard === word ? '' : ' '}${word}`));
    await pause(260);
  }
  await tab.screenshot({
    path: out('billing'),
    clip: { x: SIZE.width - 350, y: 6, width: 344, height: 86 },
  });
  await tab.evaluate(() => window.hush());
  await waitFor(
    () => mock.realtimeEvents.some((event) => event.type === 'input_audio_buffer.commit'),
    'the commit',
  );
  mock.send(completed('item_1', demo.heard));
  await waitFor(async () => (await panel()).includes(demo.reply.suggestions[2].text), 'the reply');
  await pause(600);
  await tab.screenshot({ path: out('demo') });
  await pause(2800);

  await tab.keyboard.press('1');
  await waitFor(async () => (await panel()).includes(t('copied')), 'the copied status');
  await pause(2200);

  await clickPanelButton(context, tab, 'look');
  await waitFor(async () => (await panel()).includes(demo.scene.suggestions[0].text), 'scene topics');
  await pause(600);
  await tab.screenshot({ path: out('demo-scene') });
  await pause(3500);

  await writeGif(await stopRecording(), frameDir, join(OUT, `demo${demo.suffix}.gif`));
  await extension.close();
  console.log(`${language} demo written to ${OUT}`);
} catch (err) {
  console.error(err);
  await extension.close();
  process.exitCode = 1;
} finally {
  mock.close();
  await rm(frameDir, { recursive: true, force: true });
}
