// Records the README demo: the built extension on a mock video chat page,
// driven by scripted transcripts and replies. Everything shown is demo data.
// Usage: npm run demo  (needs ffmpeg for the GIF)
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completed,
  delta,
  launchExtension,
  panelText,
  startMocks,
  waitFor,
} from '../e2e/harness.mjs';

const OUT = 'docs/images';
const SIZE = { width: 1280, height: 600 };
const HEARD = "Hey! Where are you from? It's pretty late here.";

const PAGE = `<!doctype html><meta charset="utf-8"><title>demo</title>
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
  <div class="badge">演示数据 · 并非真实聊天</div>
</div>
<div class="bar"><div class="next">下一位</div><div>停止</div><div style="flex:1">发消息…</div></div>
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
    context.fillText('你', 640, 420);
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

const OPENER = {
  language: 'en',
  translation: '',
  ipa: '',
  suggestions: [
    { style: '轻松', text: "Hey, how's your day going?", ipa: '/heɪ haʊz jʊr deɪ ˈɡoʊɪŋ/', zh: '嗨，今天过得怎么样？' },
    { style: '幽默', text: "Finally, someone who's awake!", ipa: '/ˈfaɪnəli ˈsʌmˌwʌn huz əˈweɪk/', zh: '终于遇到一个醒着的人了！' },
    { style: '追问', text: 'Where are you calling from?', ipa: '/wɛr ɑr ju ˈkɔlɪŋ frʌm/', zh: '你在哪儿呀？' },
  ],
};

const REPLY = {
  language: 'en',
  translation: '嘿！你是哪里人？我这边挺晚了。',
  ipa: '/heɪ wɛr ɑr ju frʌm ɪts ˈprɪti leɪt hɪr/',
  suggestions: [
    { style: '轻松', text: "I'm from Shanghai, it's just after lunch here.", ipa: '/aɪm frʌm ˌʃæŋˈhaɪ ɪts dʒʌst ˈæftɚ lʌntʃ hɪr/', zh: '我是上海的，我这边刚吃完午饭。' },
    { style: '幽默', text: "Late night? Then I'm your bedtime story.", ipa: '/leɪt naɪt ðɛn aɪm jʊr ˈbɛdˌtaɪm ˈstɔri/', zh: '这么晚？那我就是你的睡前故事了。' },
    { style: '追问', text: 'What keeps you up so late?', ipa: '/wʌt kips ju ʌp soʊ leɪt/', zh: '什么让你熬这么晚？' },
  ],
};

const SCENE = {
  scene: '墙上有一张东京马拉松海报，旁边靠着一把吉他',
  suggestions: [
    { style: '轻松', text: 'Wait, did you run the Tokyo Marathon?', ipa: '/weɪt dɪd ju rʌn ðə ˈtoʊkioʊ ˈmɛrəˌθɑn/', zh: '等等，你跑过东京马拉松？' },
    { style: '幽默', text: 'Runner and guitarist? Leave some talent for us.', ipa: '/ˈrʌnɚ ænd ɡɪˈtɑrɪst liv sʌm ˈtælənt fɔr ʌs/', zh: '又跑步又弹吉他？给别人留点才艺吧。' },
    { style: '追问', text: 'Do you play that guitar, or is it decoration?', ipa: '/du ju pleɪ ðæt ɡɪˈtɑr ɔr ɪz ɪt ˌdɛkəˈreɪʃən/', zh: '那把吉他你会弹吗，还是摆设？' },
  ],
};

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
  page: PAGE,
  files: { '/scene.jpg': { type: 'image/jpeg', body: await readFile('test/fixtures/scene.jpg') } },
  delayMs: 900,
  respond: (request) => {
    const content = request.body.messages[1].content;
    if (Array.isArray(content)) return SCENE;
    return content.includes('<transcript>') ? REPLY : OPENER;
  },
});
const frameDir = await mkdtemp(join(tmpdir(), 'copilot-demo-'));
const extension = await launchExtension();
const { context, worker } = extension;

try {
  await worker.evaluate(
    (apiBaseUrl) =>
      chrome.storage.local.set({
        openaiKey: 'sk-demo',
        languages: 'en',
        profile: '上海程序员，喜欢跑步和吉他',
        apiBaseUrl,
      }),
    `http://localhost:${mock.port}/v1`,
  );

  const page = await context.newPage();
  await page.setViewportSize(SIZE);
  await page.goto(`http://localhost:${mock.port}/`);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: `http://localhost:${mock.port}`,
  });
  const panel = () => panelText(context, page);
  const stopRecording = recordFrames(page, frameDir);
  await pause(800);

  await extension.toggle();
  await waitFor(async () => (await panel()).includes(OPENER.suggestions[1].text), 'openers');
  await waitFor(() => mock.socket, 'the Realtime connection');
  await pause(2200);

  await page.evaluate(() => window.talk());
  await waitFor(async () => (await panel()).includes('计费中'), 'the billing indicator');
  let heard = '';
  for (const word of HEARD.split(' ')) {
    heard += `${heard ? ' ' : ''}${word}`;
    mock.send(delta(`${heard === word ? '' : ' '}${word}`));
    await pause(260);
  }
  await page.screenshot({
    path: join(OUT, 'billing.png'),
    clip: { x: SIZE.width - 350, y: 6, width: 344, height: 86 },
  });
  await page.evaluate(() => window.hush());
  await waitFor(
    () => mock.realtimeEvents.some((event) => event.type === 'input_audio_buffer.commit'),
    'the commit',
  );
  mock.send(completed('item_1', HEARD));
  await waitFor(async () => (await panel()).includes(REPLY.suggestions[2].text), 'the reply');
  await pause(600);
  await page.screenshot({ path: join(OUT, 'demo.png') });
  await pause(2800);

  await page.keyboard.press('1');
  await waitFor(async () => (await panel()).includes('已复制'), 'the copied status');
  await pause(2200);

  // The 看画面 button sits at a fixed spot in the panel header.
  await page.mouse.click(SIZE.width - 16 - 320 + 137, 36);
  await waitFor(async () => (await panel()).includes(SCENE.suggestions[0].text), 'scene topics');
  await pause(600);
  await page.screenshot({ path: join(OUT, 'demo-scene.png') });
  await pause(3500);

  await writeGif(await stopRecording(), frameDir, join(OUT, 'demo.gif'));
  await extension.close();
  console.log(`demo written to ${OUT}`);
} catch (err) {
  console.error(err);
  await extension.close();
  process.exitCode = 1;
} finally {
  mock.close();
  await rm(frameDir, { recursive: true, force: true });
}
