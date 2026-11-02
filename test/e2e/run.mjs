// Loads the built extension into real Chromium and runs the whole pipeline
// against local stand-ins for OpenAI and Kimi: a page plays a tone, the
// extension captures it, and the suggestions must reach the in-page panel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const PAGE = `<!doctype html><title>test</title>
<button id="play">play</button><button id="quiet">quiet</button>
<video id="local-video" muted autoplay width="80"></video>
<video id="remote-video" muted autoplay width="320"></video><script>
  const paint = (id, color) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    const draw = () => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1280, 720);
    };
    draw();
    setInterval(draw, 100);
    document.getElementById(id).srcObject = canvas.captureStream(10);
  };
  paint('local-video', '#0000ff');
  paint('remote-video', '#ff0000');
  let osc;
  document.getElementById('play').onclick = () => {
    const ctx = new AudioContext();
    osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
  };
  document.getElementById('quiet').onclick = () => osc.stop();
</script>`;

const REPLY = {
  language: 'en',
  translation: '你好，你从哪里来？',
  ipa: '/haɪ wɛr ɑr ju frʌm/',
  suggestions: [
    { style: '轻松', text: 'Hi, I am from China', ipa: '/haɪ aɪ æm frʌm ˈtʃaɪnə/', zh: '你好，我来自中国' },
    { style: '幽默', text: 'Very far away', ipa: '/ˈvɛri fɑr əˈweɪ/', zh: '从很远的地方' },
    { style: '追问', text: 'And you?', ipa: '/ænd ju/', zh: '你呢？' },
  ],
};

const OPENER = {
  language: 'es',
  translation: '',
  ipa: '',
  suggestions: [
    { style: '轻松', text: 'Hola, buenas', ipa: '', zh: '你好' },
    { style: '幽默', text: 'Por fin alguien', ipa: '', zh: '终于有人了' },
    { style: '追问', text: '¿De dónde eres?', ipa: '', zh: '你是哪里人？' },
  ],
};

const SCENE = {
  scene: '背景里有一把吉他',
  suggestions: [
    { style: '轻松', text: 'Nice guitar', ipa: '/naɪs ɡɪˈtɑr/', zh: '吉他不错' },
    { style: '幽默', text: 'Play me a song', ipa: '/pleɪ mi ə sɔŋ/', zh: '给我弹一首' },
    { style: '追问', text: 'Do you play?', ipa: '/du ju pleɪ/', zh: '你会弹吗？' },
  ],
};

const audio = { chunks: 0, bytes: 0, peak: 0 };
const secretRequests = [];
const chatRequests = [];
const realtimeEvents = [];
let realtimeUrl = null;
let realtimeSocket = null;
let authProtocols = null;

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  if (req.method !== 'POST') return res.writeHead(404).end();

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const request = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    if (req.url === '/v1/realtime/client_secrets') {
      secretRequests.push(request);
      return json(res, { value: 'ek_test', expires_at: 0 });
    }
    chatRequests.push(request);
    const content = request.body.messages[1].content;
    let reply = REPLY;
    if (Array.isArray(content)) reply = SCENE;
    else if (!content.includes('<transcript>')) reply = OPENER;
    json(res, {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 200 },
    });
  });
});

const sockets = new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    authProtocols = [...protocols];
    return 'realtime';
  },
});
sockets.on('connection', (socket, req) => {
  realtimeUrl = new URL(req.url, 'ws://localhost');
  realtimeSocket = socket;
  socket.on('message', (data) => {
    const event = JSON.parse(data);
    if (event.type !== 'input_audio_buffer.append') {
      realtimeEvents.push(event);
      return;
    }
    const pcm = Buffer.from(event.audio, 'base64');
    audio.chunks++;
    audio.bytes += pcm.length;
    for (let i = 0; i < pcm.length; i += 2) {
      audio.peak = Math.max(audio.peak, Math.abs(pcm.readInt16LE(i)));
    }
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

// The real extension gets host access from the action click through activeTab,
// which automation cannot trigger, so the test copy is granted it directly.
const root = await realpath(await mkdtemp(join(tmpdir(), 'copilot-e2e-')));
const extension = join(root, 'extension');
await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://localhost/*');
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));

// Chromium derives unpacked extension ids from the path.
const extensionId = [...createHash('sha256').update(extension).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

const context = await chromium.launchPersistentContext(join(root, 'profile'), {
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    `--allowlisted-extension-id=${extensionId}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function waitFor(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function serverSends(event) {
  realtimeSocket.send(JSON.stringify(event));
}

const delta = (text) => ({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: 'item_1',
  content_index: 0,
  delta: text,
});

const completed = (itemId, transcript) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  content_index: 0,
  transcript,
});

const commits = () =>
  realtimeEvents.filter((event) => event.type === 'input_audio_buffer.commit').length;

let failed = false;
try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  assert.ok(worker.url().includes(extensionId), `unexpected extension id: ${worker.url()}`);

  await worker.evaluate(
    (apiBaseUrl) =>
      chrome.storage.local.set({
        openaiKey: 'sk-openai',
        kimiKey: 'sk-kimi',
        replyProvider: 'kimi',
        languages: 'es, en',
        profile: 'likes skiing',
        level: 'beginner',
        apiBaseUrl,
      }),
    `http://localhost:${port}/v1`,
  );

  const page = await context.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.click('#play');

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost/*' });
    await toggle(tab);
  });

  // Playwright pierces open shadow roots only, so read the closed panel via CDP text.
  const panelText = async () => {
    const client = await context.newCDPSession(page);
    await client.send('DOM.enable');
    const { root: doc } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const texts = [];
    const walk = (node) => {
      if (node.nodeType === 3 && node.parentId && node.nodeValue.trim()) texts.push(node.nodeValue);
      if (node.nodeName !== 'STYLE') {
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
      }
    };
    walk(doc);
    await client.detach();
    return texts.join('\n');
  };

  await waitFor(() => chatRequests.length === 1, 'the opener request');
  assert.ok(chatRequests[0].body.messages[1].content.includes('openers in es'));
  assert.ok(chatRequests[0].body.messages[0].content.includes('likes skiing'));
  assert.ok(chatRequests[0].body.messages[0].content.includes('beginner'));
  await waitFor(async () => (await panelText()).includes('Por fin alguien'), 'openers in the panel');

  await waitFor(() => realtimeSocket, 'the Realtime connection');
  assert.equal(secretRequests[0].headers.authorization, 'Bearer sk-openai');
  assert.equal(secretRequests[0].body.session.type, 'transcription');
  assert.deepEqual(authProtocols, ['realtime', 'openai-insecure-api-key.ek_test']);
  assert.equal(realtimeUrl.searchParams.get('intent'), 'transcription');

  await waitFor(() => realtimeEvents.length > 0, 'session.update');
  const [update] = realtimeEvents;
  assert.equal(update.type, 'session.update');
  assert.deepEqual(update.session.audio.input.transcription.languages, ['es', 'en']);

  await waitFor(() => audio.chunks >= 10, 'captured audio');
  assert.equal(audio.bytes / audio.chunks, 4800, 'expected 100 ms chunks of 16-bit 24 kHz PCM');
  await waitFor(() => audio.peak > 1000, `non-silent audio (peak ${audio.peak})`, 5000);
  console.log(`audio: ${audio.chunks} chunks, peak ${audio.peak}`);
  await waitFor(async () => (await panelText()).includes('计费中'), 'the billing indicator');
  await page.screenshot({ path: join(process.cwd(), 'test/e2e/panel-sending.png') });
  assert.equal(commits(), 0, 'no commit while the tone is still playing');

  serverSends(delta('hola'));
  serverSends(delta(' de'));
  await waitFor(async () => (await panelText()).includes('hola de'), 'interim text in the panel');

  await page.click('#quiet');
  await waitFor(() => commits() === 1, 'the extension to commit after silence');

  const chunksAtCommit = audio.chunks;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(audio.chunks, chunksAtCommit, 'silence after a turn must not be sent');
  await waitFor(async () => (await panelText()).includes('没有发送语音'), 'billing to go idle');

  serverSends(completed('item_1', 'hola de donde eres'));
  await waitFor(() => chatRequests.length === 2, 'the Kimi request');
  const request = chatRequests[1];
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer sk-kimi');
  assert.equal(request.body.model, 'kimi-k3.1-pro-highspeed');
  assert.equal(request.body.reasoning_effort, 'low');
  assert.ok(request.body.messages[1].content.includes('对方: hola de donde eres'));

  await waitFor(async () => (await panelText()).includes('Hi, I am from China'), 'suggestions');
  const text = await panelText();
  for (const expected of [REPLY.translation, 'Very far away', 'And you?', '你呢？', '轻松', REPLY.ipa, '/ænd ju/']) {
    assert.ok(text.includes(expected), `panel is missing ${expected}`);
  }
  await waitFor(async () => /语音 \d+\.\d 分钟 · 转写约 \$/.test(await panelText()), 'the cost meter');

  await page.screenshot({ path: join(process.cwd(), 'test/e2e/panel.png') });

  // The panel is a closed shadow root, so click it by position like a user.
  // These offsets come from the fixed panel layout: card 1, then header buttons.
  const viewport = page.viewportSize();
  const panelLeft = viewport.width - 16 - 320;
  const picked = /已复制|已记录/;
  await page.mouse.click(panelLeft + 160, 215);
  await waitFor(async () => picked.test(await panelText()), 'the picked status');
  await page.keyboard.press('2');
  await page.mouse.click(panelLeft + 252, 36);
  await waitFor(() => chatRequests.length === 3, 'a regenerated reply');
  const regenerated = chatRequests[2].body.messages[1].content;
  assert.ok(regenerated.includes('我: Hi, I am from China'), 'a clicked reply joins the conversation');
  assert.ok(regenerated.includes('我: Very far away'), 'a number key picks the second reply');
  await waitFor(async () => (await panelText()).includes('en ·'), 'regenerated suggestions');

  await page.mouse.click(panelLeft + 137, 36);
  await waitFor(() => chatRequests.length === 4, 'the scene request');
  const sceneRequest = chatRequests[3];
  assert.equal(sceneRequest.headers.authorization, 'Bearer sk-openai');
  assert.equal(sceneRequest.body.model, 'gpt-6-luna');
  const { url, detail } = sceneRequest.body.messages[1].content[1].image_url;
  assert.equal(detail, 'low');
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
  assert.ok(sceneRequest.body.messages[1].content[0].text.includes('in en'));
  const frame = await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const [red, green, blue] = context.getImageData(10, 10, 1, 1).data;
    return { width: image.width, height: image.height, red, green, blue };
  }, url);
  assert.equal(frame.width, 512, 'the frame should be scaled down');
  assert.ok(frame.red > 200 && frame.blue < 60, 'the frame must come from #remote-video');
  await waitFor(async () => (await panelText()).includes('画面：背景里有一把吉他'), 'the scene');
  await waitFor(async () => (await panelText()).includes('Do you play?'), 'scene topics');

  await page.mouse.click(panelLeft + 195, 36);
  await waitFor(async () => !(await panelText()).includes('hola de donde eres'), 'the reset');
  await waitFor(() => chatRequests.length === 5, 'new openers after the reset');
  serverSends(completed('item_2', 'otra persona'));
  await waitFor(() => chatRequests.length === 6, 'a reply after the reset');
  const afterReset = chatRequests[5].body.messages[1].content;
  assert.ok(afterReset.includes('对方: otra persona'));
  assert.ok(!afterReset.includes('hola de donde eres'), 'reset should clear the context');
  await waitFor(async () => (await panelText()).includes('And you?'), 'suggestions after the reset');

  await worker.evaluate(() => stop());
  await waitFor(async () => !(await panelText()).includes('And you?'), 'the panel to close');
  assert.equal(await worker.evaluate(() => isCapturing()), false);

  const startCapture = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost/*' });
      await toggle(tab);
    });
  const isStopped = async () => !(await worker.evaluate(() => isCapturing()));

  await worker.evaluate(() => chrome.storage.local.set({ idleStopMs: 1500 }));
  await startCapture();
  assert.equal(await isStopped(), false);
  await waitFor(isStopped, 'the idle auto-stop');
  await waitFor(async () => (await panelText()).includes('已自动停止'), 'the idle notice');

  await worker.evaluate(() => chrome.storage.local.remove('idleStopMs'));

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.getElementById('openaiKey').value);
  assert.equal(await options.isVisible('#kimiKey'), true);
  assert.equal(await options.isVisible('#customModel'), false);
  await options.selectOption('#replyProvider', 'custom');
  assert.equal(await options.isVisible('#kimiKey'), false);
  await options.fill('#customModel', 'local-model');
  await options.fill('#customBaseUrl', 'not a url');
  await options.click('#save');
  await options.waitForFunction(() => document.getElementById('saved').textContent.includes('不正确'));
  await options.fill('#customBaseUrl', `http://localhost:${port}/custom/v1/chat/completions`);
  await options.fill('#customKey', 'sk-custom');
  await options.selectOption('#customFormat', 'json_object');
  await options.click('#save');
  await options.waitForFunction(() => document.getElementById('saved').textContent === '已保存');
  await options.close();

  const before = chatRequests.length;
  await startCapture();
  await waitFor(() => chatRequests.length > before, 'the custom model request');
  const custom = chatRequests[before];
  assert.equal(custom.url, '/custom/v1/chat/completions');
  assert.equal(custom.headers.authorization, 'Bearer sk-custom');
  assert.equal(custom.body.model, 'local-model');
  assert.equal(custom.body.reasoning_effort, undefined);
  assert.deepEqual(custom.body.response_format, { type: 'json_object' });
  assert.ok(custom.body.messages[0].content.includes('JSON schema'));
  await waitFor(async () => (await panelText()).includes('Por fin alguien'), 'custom openers');

  assert.equal(await isStopped(), false);
  await page.reload();
  await waitFor(isStopped, 'capture to stop after a page reload');
  console.log('e2e passed');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await context.close();
  sockets.close();
  server.close();
  server.closeAllConnections();
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
