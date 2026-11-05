(() => {
  const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
  const DEFAULT_MODEL = 'gpt-4o-mini';
  const STT_TIMEOUT_MS = 1200000;
  const CHAT_TIMEOUT_MS = 180000;
  const baseOf = (baseUrl) => (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const isTimeout = (e) => e?.name === 'TimeoutError';
  async function request(url, init, msgs) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(isTimeout(e) ? msgs.timeout : msgs.connect);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err?.error?.message ?? `HTTP ${res.status}`) + (msgs.hints[res.status] ?? ''));
    }
    try {
      return await res.text();
    } catch (e) {
      throw new Error(isTimeout(e) ? msgs.bodyTimeout : msgs.bodyLost);
    }
  }
  async function chat({ apiKey, model, baseUrl, messages }) {
    const base = baseOf(baseUrl);
    const seconds = Math.round(CHAT_TIMEOUT_MS / 1000);
    const raw = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    }, {
      timeout: `Request to ${base} timed out after ${seconds} seconds: the server did not answer.`,
      connect: `Could not connect to ${base}. The URL may be wrong, the server down, or host permission missing.`,
      bodyTimeout: `Request to ${base} timed out after ${seconds} seconds: the server stopped mid-response.`,
      bodyLost: `The connection to ${base} dropped while reading the response.`,
      hints: { 401: ' (wrong API key?)', 404: ' (endpoint or model not found?)' },
    });
    const content = extractContent(raw);
    if (!content) throw new Error(errorFromBody(raw) ?? 'Empty response from the server.');
    return content;
  }
  function errorFromBody(raw) {
    try {
      const e = JSON.parse(String(raw).trim())?.error;
      const msg = typeof e === 'string' ? e : e?.message;
      return msg ? String(msg) : null;
    } catch {
      return null;
    }
  }
  function extractContent(raw) {
    raw = raw.trim();
    const single = raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim();
    if (single.startsWith('{')) {
      try {
        const c = JSON.parse(single).choices?.[0]?.message?.content;
        if (c != null) return c;
      } catch {}
    }
    let out = '';
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*data:\s*(.+)$/);
      if (!m || m[1].trim() === '[DONE]') continue;
      try {
        const ch = JSON.parse(m[1]).choices?.[0];
        out += ch?.delta?.content ?? ch?.message?.content ?? '';
      } catch {}
    }
    return out;
  }
  function generateMoM({ apiKey, model, prompt, baseUrl }) {
    return chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: prompt }] });
  }
  async function testConnection({ apiKey, model, baseUrl }) {
    await chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: 'Reply briefly: ok' }] });
    return true;
  }
  async function transcribeAudio({ blob, baseUrl, apiKey, model, language, timeoutMs }) {
    const base = baseOf(baseUrl);
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    const diarize = /diarize/i.test(model);
    form.append('response_format', diarize ? 'diarized_json' : 'verbose_json');
    if (diarize) form.append('chunking_strategy', 'auto');
    if (language) form.append('language', language);
    const limit = timeoutMs || STT_TIMEOUT_MS;
    const seconds = Math.round(limit / 1000);
    const badFormat = ' (audio format not supported by the model?)';
    const raw = await request(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(limit),
    }, {
      timeout: `Audio transcription timed out after ${seconds} seconds: STT endpoint ${base} did not respond.`,
      connect: `Could not connect to ${base} for audio transcription.`,
      bodyTimeout: `Audio transcription timed out after ${seconds} seconds: ${base} stopped mid-response.`,
      bodyLost: `The connection to ${base} dropped while reading the transcript.`,
      hints: { 400: badFormat, 401: ' (wrong API key?)', 404: ' (STT endpoint or model not found?)', 415: badFormat },
    });
    return globalThis.MeetStt.parseSttResponse(raw);
  }
  globalThis.MeetOpenAI = {
    generateMoM, testConnection, transcribeAudio, extractContent, errorFromBody, DEFAULT_BASE_URL, DEFAULT_MODEL,
  };
})();
