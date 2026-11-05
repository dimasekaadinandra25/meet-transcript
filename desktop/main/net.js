const { join } = require('node:path');

const PROBE_TIMEOUT_MS = 15000;

function loadLib(root) {
  require(join(root, 'lib', 'i18n.js'));
  require(join(root, 'lib', 'stt.js'));
  require(join(root, 'lib', 'openai.js'));
}

function assertHttp(url) {
  if (!url) return;
  const { protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`Invalid URL: ${url}`);
}

async function netCall(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, name: e?.name ?? 'Error', error: e?.message ?? String(e) };
  }
}

const callChat = (args) => netCall(async () => {
  assertHttp(args.baseUrl);
  return globalThis.MeetOpenAI.generateMoM(args);
});

const callTest = (args) => netCall(async () => {
  assertHttp(args.baseUrl);
  return globalThis.MeetOpenAI.testConnection(args);
});

const callStt = ({ bytes, ...args }, engineUrl) => netCall(async () => {
  const baseUrl = args.baseUrl === globalThis.MeetStt.BUILTIN_URL ? await engineUrl() : args.baseUrl;
  assertHttp(baseUrl);
  return globalThis.MeetOpenAI.transcribeAudio({ ...args, baseUrl, blob: new Blob([bytes]) });
});

const probe = (url, key) => netCall(async () => {
  assertHttp(url);
  const res = await fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status };
});

module.exports = { loadLib, netCall, callChat, callTest, callStt, probe };
