(() => {
  function errorText(e) {
    if (typeof e === 'string') return e;
    return e?.message ? String(e.message) : JSON.stringify(e);
  }
  function parseSttResponse(raw) {
    let d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { segments: [] }; }
    if (d && Array.isArray(d.segments) && d.segments.length) {
      return { segments: d.segments.map((s) => ({ start: s.start ?? 0, text: s.text ?? '' })) };
    }
    if (d && typeof d.text === 'string' && d.text.trim()) {
      return { segments: [{ start: 0, text: d.text }] };
    }
    if (d && d.error) return { error: errorText(d.error) };
    return { segments: [] };
  }
  function mergeSttChunks(chunkResults, chunkDurationMs, baseTime, indices) {
    const out = [];
    const idx = indices?.length === chunkResults.length ? indices : null;
    chunkResults.forEach((r, i) => {
      const offset = baseTime + (idx ? idx[i] : i) * chunkDurationMs;
      if (!r || r.error) {
        out.push({ t: offset, speaker: '', text: '[transkrip gagal]' });
        return;
      }
      for (const seg of r.segments ?? []) {
        const text = (seg.text ?? '').trim();
        if (!text) continue;
        out.push({ t: offset + Math.round((seg.start ?? 0) * 1000), speaker: '', text });
      }
    });
    return out;
  }
  const WHISPER_DEFAULT = 'http://localhost:8080/v1';
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const DEFAULT_LANGUAGE = 'id';
  const DEFAULT_WHISPER_MODEL = 'whisper-1';
  const DEFAULT_API_MODEL = 'nvidia/parakeet-ctc-1.1b-asr';
  const isLocalUrl = (v) => {
    try { return LOCAL_HOSTS.has(new URL(String(v).trim()).hostname); } catch { return false; }
  };
  function sttMode(s = {}) {
    if (s.sttMode && s.sttMode !== 'browser') return s.sttMode;
    const b = (s.sttBaseUrl || '').trim();
    if (b) return isLocalUrl(b) ? 'whisper-local' : 'api';
    if (s.sttMode === 'browser') return 'whisper-local';
    return (s.apiKey || s.baseUrl) ? 'api' : 'whisper-local';
  }
  function sttEndpoint(s = {}) {
    const mode = sttMode(s);
    const sttBase = (s.sttBaseUrl || '').trim();
    const sttKey = (s.sttApiKey || '').trim();
    const language = s.sttLanguage ?? DEFAULT_LANGUAGE;
    if (mode === 'whisper-local') {
      const customModel = s.sttModel && s.sttModel !== DEFAULT_API_MODEL ? s.sttModel : null;
      return { mode: 'http', baseUrl: sttBase || WHISPER_DEFAULT, apiKey: sttKey,
        model: customModel ?? DEFAULT_WHISPER_MODEL, language };
    }
    const model = s.sttModel || DEFAULT_API_MODEL;
    if (sttBase) return { mode: 'http', baseUrl: sttBase, apiKey: sttKey, model, language };
    return { mode: 'http', baseUrl: s.baseUrl, apiKey: sttKey || s.apiKey, model, language };
  }
  globalThis.MeetStt = {
    parseSttResponse, mergeSttChunks, sttEndpoint, sttMode, isLocalUrl,
    WHISPER_DEFAULT, DEFAULT_LANGUAGE, DEFAULT_API_MODEL,
  };
})();
