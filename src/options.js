const FIELDS = [
  'openaiKey',
  'replyProvider',
  'customBaseUrl',
  'customKey',
  'customModel',
  'customFormat',
  'customReasoning',
  'profile',
  'level',
  'languages',
];

const provider = document.getElementById('replyProvider');
const saved = document.getElementById('saved');

function showProviderFields() {
  for (const el of document.querySelectorAll('[data-provider]')) {
    el.hidden = !el.dataset.provider.split(' ').includes(provider.value);
  }
}

// Must stay in the click's task: Chrome only prompts during a user gesture.
function requestCustomHost() {
  const { protocol, hostname } = new URL(document.getElementById('customBaseUrl').value.trim());
  return chrome.permissions.request({ origins: [`${protocol}//${hostname}/*`] });
}

async function customSetupError() {
  if (!document.getElementById('customModel').value.trim()) return '请填写模型名';
  try {
    return (await requestCustomHost()) ? null : '没有授权访问这个接口地址';
  } catch {
    return '接口地址不正确';
  }
}

provider.addEventListener('change', showProviderFields);

chrome.storage.local.get(FIELDS).then((values) => {
  for (const field of FIELDS) {
    if (values[field]) document.getElementById(field).value = values[field];
  }
  showProviderFields();
});

document.getElementById('save').addEventListener('click', async () => {
  const error = provider.value === 'custom' ? await customSetupError() : null;
  if (error) {
    saved.textContent = error;
    return;
  }
  const entries = FIELDS.map((field) => [field, document.getElementById(field).value.trim()]);
  await chrome.storage.local.set(Object.fromEntries(entries));
  saved.textContent = '已保存';
});
