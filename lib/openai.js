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
      timeout: `Request ke ${base} timeout setelah ${seconds} detik — server tidak menjawab.`,
      connect: `Tidak bisa terhubung ke ${base} — URL salah, server mati, atau izin host belum diberikan.`,
      bodyTimeout: `Request ke ${base} timeout setelah ${seconds} detik — server berhenti di tengah respons.`,
      bodyLost: `Koneksi ke ${base} terputus saat membaca respons.`,
      hints: { 401: ' (API key salah?)', 404: ' (endpoint atau model tidak ditemukan?)' },
    });
    const content = extractContent(raw);
    if (!content) throw new Error(errorFromBody(raw) ?? 'Respons kosong dari server.');
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
    await chat({ apiKey, model, baseUrl, messages: [{ role: 'user', content: 'Balas singkat: ok' }] });
    return true;
  }
  async function transcribeAudio({ blob, baseUrl, apiKey, model, language, timeoutMs }) {
    const base = baseOf(baseUrl);
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (language) form.append('language', language);
    const limit = timeoutMs || STT_TIMEOUT_MS;
    const seconds = Math.round(limit / 1000);
    const badFormat = ' (format audio tidak didukung model?)';
    const raw = await request(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(limit),
    }, {
      timeout: `Transkrip audio timeout setelah ${seconds} detik — endpoint STT ${base} tidak merespons.`,
      connect: `Tidak bisa terhubung ke ${base} untuk transkrip audio.`,
      bodyTimeout: `Transkrip audio timeout setelah ${seconds} detik — ${base} berhenti di tengah respons.`,
      bodyLost: `Koneksi ke ${base} terputus saat membaca hasil transkrip.`,
      hints: { 400: badFormat, 401: ' (API key salah?)', 404: ' (endpoint/model STT tidak ditemukan?)', 415: badFormat },
    });
    return globalThis.MeetStt.parseSttResponse(raw);
  }
  globalThis.MeetOpenAI = {
    generateMoM, testConnection, transcribeAudio, extractContent, errorFromBody, DEFAULT_BASE_URL, DEFAULT_MODEL,
  };
})();
