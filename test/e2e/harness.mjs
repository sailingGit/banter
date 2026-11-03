// Shared by the end-to-end test and the demo recording: local stand-ins for
// OpenAI and a compatible endpoint, and the built extension in real Chromium.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// `respond` picks the reply object for each chat request; `files` maps extra
// GET paths to { type, body }.
export async function startMocks({ page, files = {}, respond, delayMs = 0 }) {
  const mock = {
    secretRequests: [],
    chatRequests: [],
    realtimeEvents: [],
    audio: { chunks: 0, bytes: 0, peak: 0 },
    socket: null,
    url: null,
    protocols: null,
  };

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    const file = files[req.url];
    if (file) return res.writeHead(200, { 'content-type': file.type }).end(file.body);
    if (req.method !== 'POST') return res.writeHead(404).end();

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      if (req.url === '/v1/realtime/client_secrets') {
        mock.secretRequests.push(request);
        return json(res, { value: 'ek_test', expires_at: 0 });
      }
      mock.chatRequests.push(request);
      const reply = respond(request);
      setTimeout(() => {
        json(res, {
          choices: [
            { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 200 },
        });
      }, delayMs);
    });
  });

  const sockets = new WebSocketServer({
    server,
    handleProtocols: (protocols) => {
      mock.protocols = [...protocols];
      return 'realtime';
    },
  });
  sockets.on('connection', (socket, req) => {
    mock.url = new URL(req.url, 'ws://localhost');
    mock.socket = socket;
    socket.on('message', (data) => {
      const event = JSON.parse(data);
      if (event.type !== 'input_audio_buffer.append') {
        mock.realtimeEvents.push(event);
        return;
      }
      const pcm = Buffer.from(event.audio, 'base64');
      mock.audio.chunks++;
      mock.audio.bytes += pcm.length;
      for (let i = 0; i < pcm.length; i += 2) {
        mock.audio.peak = Math.max(mock.audio.peak, Math.abs(pcm.readInt16LE(i)));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  mock.port = server.address().port;
  mock.send = (event) => mock.socket.send(JSON.stringify(event));
  mock.close = () => {
    sockets.close();
    server.close();
    server.closeAllConnections();
  };
  return mock;
}

export async function launchExtension() {
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
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  return {
    context,
    extensionId,
    worker,
    // Starts or stops capture on the first localhost tab, like an action click.
    toggle: () =>
      worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'http://localhost/*' });
        await toggle(tab);
      }),
    close: async () => {
      await context.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Playwright pierces open shadow roots only, so read the closed panel via CDP text.
export async function panelText(context, page) {
  const client = await context.newCDPSession(page);
  await client.send('DOM.enable');
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const texts = [];
  const walk = (node) => {
    if (node.nodeType === 3 && node.parentId && node.nodeValue.trim()) texts.push(node.nodeValue);
    if (node.nodeName !== 'STYLE') {
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    }
  };
  walk(root);
  await client.detach();
  return texts.join('\n');
}

export async function waitFor(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const delta = (text, itemId = 'item_1') => ({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: itemId,
  content_index: 0,
  delta: text,
});

export const completed = (itemId, transcript) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  content_index: 0,
  transcript,
});
