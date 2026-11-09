const { join } = require('node:path');

const PROBE_TIMEOUT_MS = 15000;

// Loads the shared browser libraries the main process uses for AI, speech and sharing calls.
function loadLib(root) {
  require(join(root, 'lib', 'i18n.js'));
  require(join(root, 'lib', 'stt.js'));
  require(join(root, 'lib', 'openai.js'));
  require(join(root, 'lib', 'share.js'));
}

// Throws unless the address is empty or uses http or https.
function assertHttp(url) {
  if (!url) return;
  const { protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`Invalid URL: ${url}`);
}

// Runs a call and wraps its result or error in a plain object that can cross IPC.
async function netCall(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, name: e?.name ?? 'Error', error: e?.message ?? String(e) };
  }
}

// Asks the AI service to write the minutes of meeting.
const callChat = (args) => netCall(async () => {
  assertHttp(args.baseUrl);
  return globalThis.MeetOpenAI.generateMoM(args);
});

// Checks that the AI service settings work.
const callTest = (args) => netCall(async () => {
  assertHttp(args.baseUrl);
  return globalThis.MeetOpenAI.testConnection(args);
});

// Transcribes audio, using the built-in engine when the settings point at it.
const callStt = ({ bytes, ...args }, engineUrl) => netCall(async () => {
  const usesBuiltIn = args.baseUrl === globalThis.MeetStt.BUILTIN_URL;
  const baseUrl = usesBuiltIn ? await engineUrl() : args.baseUrl;
  assertHttp(baseUrl);
  return globalThis.MeetOpenAI.transcribeAudio({ ...args, baseUrl, blob: new Blob([bytes]) });
});

// Sends a meeting to a sharing destination such as Slack or Notion.
const callShare = (kind, settings, meeting) => netCall(() => globalThis.MeetShare.deliver(kind, settings, meeting));

// Fetches a service's /models list, allowing only that exact kind of address.
const probe = (url, key) => netCall(async () => {
  assertHttp(url);
  const { pathname, search, hash } = new URL(url);
  if (!pathname.endsWith('/models') || search || hash) throw new Error(`Invalid URL: ${url}`);
  const res = await fetch(url, {
    redirect: 'error',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = res.ok ? { body: await res.json().catch(() => null) } : {};
  return { ok: res.ok, status: res.status, ...body };
});

module.exports = { loadLib, netCall, callChat, callTest, callStt, callShare, probe };
