import { NATIVE_LANGUAGES, resolveNativeLanguage, translator, uiLanguage } from './i18n.js';

const FIELDS = [
  'openaiKey',
  'nativeLanguage',
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

const native = document.getElementById('nativeLanguage');
const provider = document.getElementById('replyProvider');
const saved = document.getElementById('saved');
let t = translator('en');

for (const [code, { label }] of Object.entries(NATIVE_LANGUAGES)) {
  native.add(new Option(label, code));
}

// The page follows the language picked here, before it is even saved.
function localize() {
  const language = uiLanguage(native.value);
  t = translator(language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = t('options.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  saved.textContent = '';
}

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
  if (!document.getElementById('customModel').value.trim()) return t('options.needModel');
  try {
    return (await requestCustomHost()) ? null : t('options.noAccess');
  } catch {
    return t('options.badUrl');
  }
}

native.addEventListener('change', localize);
provider.addEventListener('change', showProviderFields);

chrome.storage.local.get(FIELDS).then((values) => {
  for (const field of FIELDS) {
    if (values[field]) document.getElementById(field).value = values[field];
  }
  native.value = resolveNativeLanguage(values.nativeLanguage);
  localize();
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
  saved.textContent = t('options.saved');
});
