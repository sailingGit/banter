(() => {
  if (window.__copilotOverlay) return;
  window.__copilotOverlay = true;

  const MAX_FRAME_SIDE = 512;
  const BILLING_ON = '● 计费中 · 正在发送语音';
  const BILLING_OFF = '○ 待机 · 没有发送语音';

  const STYLES = `
    .panel {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: 320px; max-height: calc(100vh - 32px); overflow-y: auto;
      box-sizing: border-box; padding: 12px; border-radius: 12px;
      background: rgba(20, 22, 28, 0.94); color: #f1f2f5;
      font: 14px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
    }
    header { display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; }
    .status { flex: 1; min-width: 0; font-size: 12px; color: #a3a8b4; }
    .status.error { color: #ff8a80; }
    button {
      flex: none; border: 0; border-radius: 6px; padding: 3px 8px; cursor: pointer;
      background: #333844; color: inherit; font: inherit; font-size: 12px;
    }
    button:hover { background: #454b5a; }
    .billing {
      margin-top: 8px; padding: 3px 8px; border-radius: 6px;
      background: #262a34; color: #a3a8b4; font-size: 12px;
    }
    .billing.on { background: #5a2226; color: #ffb4ab; font-weight: 600; }
    .heard { margin-top: 10px; color: #c9ced8; word-break: break-word; }
    .heard:empty, .translation:empty, .ipa:empty { display: none; }
    .ipa { display: block; margin-top: 2px; font-size: 12px; color: #9fd3b6; word-break: break-word; }
    .translation { margin-top: 4px; font-weight: 600; }
    .card {
      position: relative; box-sizing: border-box; margin-top: 8px; padding: 8px 10px;
      border-radius: 6px; background: #262a34; font-size: 14px; cursor: pointer;
    }
    .card:hover { background: #2f3440; }
    .card.picked { outline: 1px solid #6fcf97; }
    .speak { position: absolute; top: 6px; right: 6px; padding: 1px 6px; font-size: 11px; }
    .tag { font-size: 11px; color: #8ab4f8; }
    .text { display: block; margin-top: 2px; font-size: 15px; word-break: break-word; }
    .zh { display: block; margin-top: 2px; font-size: 12px; color: #a3a8b4; }
    .meter { margin-top: 8px; font-size: 11px; color: #7f8592; text-align: right; }
    .meter:empty { display: none; }
  `;

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${STYLES}</style>
    <div class="panel">
      <header>
        <span class="status">准备中…</span>
        <button data-action="look" title="截取页面上的视频画面，发给 OpenAI 找话题">看画面</button>
        <button data-action="reset" title="换了新对象时清空上下文">新对话</button>
        <button data-action="regenerate">换一批</button>
        <button data-action="stop" title="停止">×</button>
      </header>
      <div class="billing">${BILLING_OFF}</div>
      <div class="heard"></div>
      <div class="ipa heard-ipa"></div>
      <div class="translation"></div>
      <div class="cards"></div>
      <div class="meter"></div>
    </div>`;
  document.documentElement.append(host);

  // The offscreen document stops capture when this port closes with the page.
  const port = chrome.runtime.connect({ name: 'overlay' });

  const panel = root.querySelector('.panel');
  const status = root.querySelector('.status');
  const billing = root.querySelector('.billing');
  const heard = root.querySelector('.heard');
  const heardIpa = root.querySelector('.heard-ipa');
  const translation = root.querySelector('.translation');
  const cards = root.querySelector('.cards');
  const meter = root.querySelector('.meter');

  let replyLanguage = 'en';

  function setStatus(text, level) {
    status.textContent = text;
    status.classList.toggle('error', level === 'error');
  }

  function clearReply() {
    heardIpa.textContent = '';
    translation.textContent = '';
    cards.replaceChildren();
  }

  function speak(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = replyLanguage;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  async function pick(el, text) {
    // Record first, so a quick "换一批" already sees this reply.
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'picked', text });
    cards.querySelector('.picked')?.classList.remove('picked');
    el.classList.add('picked');
    const copied = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (el.isConnected) setStatus(copied ? '已复制' : '已记录，复制失败');
  }

  function card({ style, text, ipa, zh }, index) {
    const el = document.createElement('div');
    el.className = 'card';
    const label = `${index + 1} ${style}`;
    for (const [name, value] of [['tag', label], ['text', text], ['ipa', ipa], ['zh', zh]]) {
      const span = document.createElement('span');
      span.className = name;
      span.textContent = value;
      el.append(span);
    }

    const speakButton = document.createElement('button');
    speakButton.className = 'speak';
    speakButton.textContent = '朗读';
    speakButton.addEventListener('click', (event) => {
      event.stopPropagation();
      speak(text);
    });
    el.append(speakButton);

    el.addEventListener('click', () => pick(el, text));
    el.dataset.text = text;
    return el;
  }

  // Sites that label their videos get exact matching, so the user's own preview
  // is never sent. Everywhere else the largest video is the best guess.
  function findVideo() {
    const remote = document.querySelector('video#remote-video');
    const videos = remote
      ? [remote]
      : [...document.querySelectorAll('video')].filter((video) => video.id !== 'local-video');
    return videos
      .filter((video) => video.videoWidth > 0)
      .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  }

  function grabFrame(video) {
    const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  function look() {
    const video = findVideo();
    if (!video) {
      setStatus('页面上没有可用的视频画面', 'error');
      return;
    }
    try {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'look', image: grabFrame(video) });
    } catch (err) {
      console.error('[copilot] frame capture failed', err);
      setStatus('这个页面不允许截取画面', 'error');
    }
  }

  function onKey(event) {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.composedPath()[0];
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      return;
    }
    const el = cards.children[Number(event.key) - 1];
    if (el) pick(el, el.dataset.text);
  }
  window.addEventListener('keydown', onKey);

  const handlers = {
    status: (msg) => setStatus(msg.text, msg.level),
    interim: (msg) => {
      heard.textContent = msg.text;
    },
    utterance: (msg) => {
      heard.textContent = msg.text;
      clearReply();
    },
    suggestions: (msg) => {
      replyLanguage = msg.language;
      heardIpa.textContent = msg.ipa;
      translation.textContent = msg.translation;
      cards.replaceChildren(...msg.suggestions.map(card));
      setStatus(`${msg.language} · ${(msg.ms / 1000).toFixed(1)}s`);
    },
    reset: () => {
      heard.textContent = '';
      clearReply();
      setStatus('正在听…');
    },
    billing: (msg) => {
      billing.classList.toggle('on', msg.active);
      billing.textContent = msg.active ? BILLING_ON : BILLING_OFF;
    },
    meter: (msg) => {
      meter.textContent = msg.text;
    },
    stop: (msg) => {
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('keydown', onKey);
      speechSynthesis.cancel();
      port.disconnect();
      window.__copilotOverlay = false;
      if (!msg.notice) {
        host.remove();
        return;
      }
      // Leave the reason on screen briefly; a restart meanwhile builds a new panel.
      setStatus(msg.notice);
      panel.style.pointerEvents = 'none';
      setTimeout(() => host.remove(), 5000);
    },
  };

  function onMessage(msg) {
    handlers[msg.type]?.(msg);
  }
  chrome.runtime.onMessage.addListener(onMessage);

  root.querySelector('header').addEventListener('click', (event) => {
    const action = event.target.dataset?.action;
    if (action === 'stop') chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    else if (action === 'look') look();
    else if (action) chrome.runtime.sendMessage({ target: 'offscreen', type: action });
  });

  // The panel can sit on top of the site's own chat, so let it be moved.
  root.querySelector('header').addEventListener('pointerdown', (event) => {
    if (event.target.tagName === 'BUTTON') return;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (e) => {
      panel.style.left = `${e.clientX - offsetX}px`;
      panel.style.top = `${e.clientY - offsetY}px`;
      panel.style.right = 'auto';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), {
      once: true,
    });
  });
})();
