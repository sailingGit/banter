const SETTING_KEYS = [
  'openaiKey',
  'nativeLanguage',
  'replyProvider',
  'customBaseUrl',
  'customKey',
  'customModel',
  'customFormat',
  'customReasoning',
  'languages',
  'profile',
  'level',
  'apiBaseUrl',
  'idleStopMs',
];

async function isCapturing() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

function isConfigured(settings) {
  if (!settings.openaiKey) return false;
  if (settings.replyProvider !== 'custom') return true;
  return settings.customBaseUrl && settings.customModel;
}

async function start(tab) {
  const settings = await chrome.storage.local.get(SETTING_KEYS);
  if (!isConfigured(settings)) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for live transcription.',
  });
  // The overlay connects to the offscreen document as it loads, so this order matters.
  try {
    // The overlay reads this as it builds, to pick its language.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (nativeLanguage) => {
        window.__banterNativeLanguage = nativeLanguage;
      },
      args: [settings.nativeLanguage ?? null],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
  } catch (err) {
    await chrome.offscreen.closeDocument();
    throw err;
  }
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    tabId: tab.id,
    settings,
  });

  await chrome.storage.session.set({ tabId: tab.id });
  await chrome.action.setBadgeText({ text: 'ON' });
}

async function stop(notice) {
  const { tabId } = await chrome.storage.session.get('tabId');
  if (await isCapturing()) await chrome.offscreen.closeDocument();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'stop', notice }).catch(() => {});
  await chrome.storage.session.remove('tabId');
  await chrome.action.setBadgeText({ text: '' });
}

async function toggle(tab) {
  if (await isCapturing()) await stop();
  else await start(tab);
}

chrome.action.onClicked.addListener((tab) => {
  toggle(tab).catch((err) => console.error('[banter] toggle failed', err));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'overlay') {
    // The tab can be closing or navigating; a lost update is harmless.
    chrome.tabs.sendMessage(msg.tabId, msg.payload).catch(() => {});
  } else if (msg.type === 'stop') {
    stop(msg.notice).catch((err) => console.error('[banter] stop failed', err));
  }
});
