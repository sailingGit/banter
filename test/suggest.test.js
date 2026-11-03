import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resolveNativeLanguage, translator, uiLanguage } from '../src/i18n.js';
import {
  ApiError,
  ReplyError,
  aboutUser,
  buildRequest,
  buildSceneRequest,
  buildTranscript,
  createClient,
  createVisionClient,
  describeError,
  replyCost,
  suggest,
} from '../src/suggest.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = { language: 'es', translation: '你好', suggestions: [] };
const turns = [{ speaker: 'them', text: 'hola' }];

function mockCompletion(message, finishReason = 'stop') {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }));
  };
  return calls;
}

test('transcript labels speakers and keeps only recent turns', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    speaker: i % 2 ? 'me' : 'them',
    text: `line ${i}`,
  }));
  const transcript = buildTranscript(many);
  assert.ok(transcript.includes('User: line 19'));
  assert.ok(transcript.includes('Other person: line 18'));
  assert.ok(!transcript.includes('line 7'));
});

test('OpenAI is the default route and uses the OpenAI key', () => {
  const client = createClient({ openaiKey: 'sk-o', customKey: 'sk-c' });
  assert.equal(client.baseUrl, 'https://api.openai.com/v1');
  assert.equal(client.model, 'gpt-6-luna');
  assert.equal(client.reasoningEffort, 'none');
  assert.equal(client.apiKey, 'sk-o');
});

test('a custom route uses the configured endpoint, key and model', () => {
  const client = createClient({
    replyProvider: 'custom',
    customBaseUrl: 'https://llm.example/v1/chat/completions/',
    customKey: 'sk-c',
    customModel: 'my-model',
    openaiKey: 'sk-o',
  });
  assert.equal(client.baseUrl, 'https://llm.example/v1');
  assert.equal(client.apiKey, 'sk-c');
  const body = buildRequest(client, turns);
  assert.equal(body.model, 'my-model');
  assert.equal(body.response_format.type, 'json_schema');
  assert.ok(!('reasoning_effort' in JSON.parse(JSON.stringify(body))));
});

test('custom models without schema support get the shape in the prompt', () => {
  const settings = { replyProvider: 'custom', customBaseUrl: 'https://llm.example/v1' };
  const object = buildRequest(createClient({ ...settings, customFormat: 'json_object' }), turns);
  assert.deepEqual(object.response_format, { type: 'json_object' });
  assert.ok(object.messages[0].content.includes('JSON schema'));
  const plain = buildRequest(createClient({ ...settings, customFormat: 'none' }), turns);
  assert.equal(plain.response_format, undefined);
  assert.ok(plain.messages[0].content.includes('"suggestions"'));
});

test('custom replies may arrive in a code fence, and a key is optional', async () => {
  const calls = mockCompletion({ content: `Sure:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` });
  const client = createClient({ replyProvider: 'custom', customBaseUrl: 'http://localhost:11434/v1' });
  assert.deepEqual((await suggest(client, turns)).reply, reply);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  mockCompletion({ content: '{"language":"es"}' });
  await assert.rejects(suggest(client, turns), SyntaxError);
});

test('request asks for schema-shaped JSON', () => {
  const body = buildRequest(createClient({}), turns);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'reply_suggestions');
  const { schema } = body.response_format.json_schema;
  assert.ok(schema.properties.suggestions);
  assert.ok(schema.required.includes('ipa'));
  assert.ok(schema.properties.suggestions.items.required.includes('ipa'));
  assert.ok(schema.properties.suggestions.items.required.includes('meaning'));
  assert.deepEqual(schema.properties.suggestions.items.properties.style.enum, [
    'relaxed',
    'playful',
    'follow-up',
  ]);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[1].content.includes('Other person: hola'));
});

test('the native language follows the setting, then the browser', () => {
  assert.equal(resolveNativeLanguage('ja', 'en-US'), 'ja');
  assert.equal(resolveNativeLanguage(undefined, 'zh-CN'), 'zh-CN');
  assert.equal(resolveNativeLanguage(undefined, 'zh-HK'), 'zh-TW');
  assert.equal(resolveNativeLanguage(undefined, 'de-AT'), 'de');
  assert.equal(resolveNativeLanguage('xx', 'sv-SE'), 'en');
  assert.equal(uiLanguage('zh-TW'), 'zh');
  assert.equal(uiLanguage('ja'), 'en');
});

test('replies explain themselves in the user language', () => {
  const english = createClient({ nativeLanguage: 'en' });
  assert.ok(buildRequest(english, turns).messages[0].content.includes("The user's language is English."));
  const chinese = createClient({ nativeLanguage: 'zh-CN' });
  assert.ok(aboutUser(chinese).includes('Simplified Chinese'));
});

test('the profile and level shape the prompt without inviting invented facts', () => {
  const client = createClient({ profile: ' likes cats ', level: 'beginner' });
  const about = aboutUser(client);
  assert.ok(about.includes('<profile>\nlikes cats\n</profile>'));
  assert.ok(about.includes('beginner'));
  assert.ok(about.includes('Never invent facts'));
  assert.ok(aboutUser(createClient({})).includes('intermediate'));
  assert.ok(aboutUser(createClient({})).includes('Never invent facts'));
  assert.ok(buildRequest(client, turns).messages[0].content.includes('likes cats'));
});

test('an empty conversation asks for openers in the first listed language', () => {
  const opener = (settings) => buildRequest(createClient(settings), []).messages[1].content;
  assert.ok(opener({ languages: 'ru, es' }).includes('openers in ru'));
  assert.ok(opener({}).includes('openers in en'));
  assert.ok(!opener({}).includes('<transcript>'));
});

test('scene requests go to OpenAI with one low-detail image', () => {
  const client = createVisionClient({
    replyProvider: 'custom',
    customBaseUrl: 'https://llm.example/v1',
    openaiKey: 'sk-o',
    customKey: 'sk-c',
  });
  assert.equal(client.apiKey, 'sk-o');
  assert.equal(client.model, 'gpt-6-luna');

  const body = buildSceneRequest(client, 'data:image/jpeg;base64,AAAA', 'ru');
  assert.equal(body.response_format.json_schema.name, 'scene_topics');
  const [text, image] = body.messages[1].content;
  assert.ok(text.text.includes('in ru'));
  assert.deepEqual(image, {
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,AAAA', detail: 'low' },
  });
  const system = body.messages[0].content;
  assert.ok(system.includes('Never try to identify the person'));
  assert.ok(system.includes('nudity'));
});

test('suggest posts to the provider and parses the reply', async () => {
  const calls = mockCompletion({ content: JSON.stringify(reply) });
  const client = createClient({ openaiKey: 'sk-o' });
  assert.deepEqual((await suggest(client, turns)).reply, reply);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-o');
});

test('reply cost uses token usage where a price is known', () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  assert.ok(Math.abs(replyCost(createClient({}), usage) - 0.6) < 1e-9);
  assert.equal(replyCost(createClient({}), undefined), 0);
  const custom = createClient({ replyProvider: 'custom', customBaseUrl: 'https://llm.example/v1' });
  assert.equal(replyCost(custom, usage), 0);
});

test('suggest reports refusals and truncation instead of parsing them', async () => {
  const client = createClient({ openaiKey: 'sk-o' });
  const code = (expected) => (err) => err instanceof ReplyError && err.code === expected;
  mockCompletion({ refusal: 'no' });
  await assert.rejects(suggest(client, turns), code('refused'));
  mockCompletion({ content: '' }, 'content_filter');
  await assert.rejects(suggest(client, turns), code('refused'));
  mockCompletion({ content: '{"lang' }, 'length');
  await assert.rejects(suggest(client, turns), code('truncated'));
});

test('API failures become readable messages', async () => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  const client = createClient({ openaiKey: 'bad' });
  const err = await suggest(client, turns).catch((e) => e);
  assert.ok(err instanceof ApiError);
  const zh = translator('zh');
  const en = translator('en');
  assert.equal(describeError(err, zh), 'OpenAI Key 无效');
  assert.equal(describeError(err, en), 'OpenAI key is invalid');
  assert.match(describeError(new ApiError('openai', 429), zh), /余额不足/);
  assert.match(describeError(new TypeError('fetch failed'), zh), /网络/);
  assert.match(describeError(new ApiError('custom', 400), zh), /自定义模型.*结构化输出/);
  assert.match(describeError(new ApiError('custom', 404), en), /^Custom endpoint error \(404\)$/);
  assert.equal(describeError(new ReplyError('truncated'), en), 'The reply was cut off');
});
