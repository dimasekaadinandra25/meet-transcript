(() => {
  const SOUND_MARKER = /^(?:\s|♪|\[[^\]]*\]|\([^)]*\))*$/;
  const isSpoken = (text) => !SOUND_MARKER.test(text ?? '');
  function errorText(e) {
    if (typeof e === 'string') return e;
    return e?.message ? String(e.message) : JSON.stringify(e);
  }
  function parseSttResponse(raw) {
    let d;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return { segments: [] }; }
    if (d && Array.isArray(d.segments) && d.segments.length) {
      return { segments: d.segments.filter((s) => isSpoken(s.text)).map((s) => ({ start: s.start ?? 0, ...(s.end === undefined ? {} : { end: s.end }), text: s.text ?? '', ...(s.speaker ? { speaker: String(s.speaker) } : {}) })) };
    }
    if (d && typeof d.text === 'string' && d.text.trim()) {
      return { segments: isSpoken(d.text) ? [{ start: 0, text: d.text }] : [] };
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
        out.push({ t: offset, speaker: '', text: '[transcript failed]', failedUntil: offset + chunkDurationMs });
        return;
      }
      for (const seg of r.segments ?? []) {
        const text = (seg.text ?? '').trim();
        if (!text) continue;
        out.push({ t: offset + Math.round((seg.start ?? 0) * 1000), speaker: seg.speaker ? `Speaker ${seg.speaker}` : '', text });
      }
    });
    return out;
  }
  const VOICE_PREFIX = 'Voice ';
  const MAX_KNOWN_VOICES = 4;
  const MIN_CLIP_SECONDS = 2;
  const MAX_CLIP_SECONDS = 6;
  const isDiarizeModel = (model) => /diarize/i.test(model ?? '');
  function createVoiceMemory() {
    const known = [];
    let used = 0;
    const nextLetter = () => {
      const index = used++;
      return index < 26 ? String.fromCharCode(65 + index) : `Z${index - 25}`;
    };
    const references = () => known.map(({ letter, clip }) => ({ name: `${VOICE_PREFIX}${letter}`, clip }));
    function nameSpeakers(segments) {
      const fresh = new Map();
      for (const seg of segments) {
        if (!seg.speaker) continue;
        if (seg.speaker.startsWith(VOICE_PREFIX)) {
          seg.speaker = seg.speaker.slice(VOICE_PREFIX.length);
          continue;
        }
        if (!fresh.has(seg.speaker)) fresh.set(seg.speaker, nextLetter());
        seg.speaker = fresh.get(seg.speaker);
      }
    }
    async function rememberClips(segments, makeClip) {
      for (const seg of segments) {
        const unknown = seg.speaker && !known.some((voice) => voice.letter === seg.speaker);
        if (!unknown || known.length >= MAX_KNOWN_VOICES || !(seg.end - seg.start >= MIN_CLIP_SECONDS)) continue;
        const clip = await makeClip(seg.start, Math.min(seg.end, seg.start + MAX_CLIP_SECONDS)).catch(() => null);
        if (clip) known.push({ letter: seg.speaker, clip });
      }
    }
    async function learn(result, makeClip) {
      const segments = result.segments ?? [];
      nameSpeakers(segments);
      await rememberClips(segments, makeClip);
      return result;
    }
    return { references, learn };
  }
  async function sendWithVoices({ send, blob, voices, makeClip }) {
    const references = voices.references();
    const result = await send(references).catch((e) => {
      if (!references.length || e.name !== 'RequestRejected') throw e;
      return send([]);
    });
    if (result.error) return result;
    return voices.learn(result, (from, to) => makeClip(blob, from, to));
  }
  const namesCanMove = (meeting, model) => isDiarizeModel(model) && Object.keys(meeting.speakerNames ?? {}).length > 0;
  const BUILTIN_URL = 'builtin:';
  const WHISPER_DEFAULT = 'http://localhost:8080/v1';
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const DEFAULT_LANGUAGE = '';
  const DEFAULT_WHISPER_MODEL = 'whisper-1';
  const DEFAULT_API_MODEL = 'nvidia/parakeet-ctc-1.1b-asr';
  const isLocalUrl = (v) => {
    try { return LOCAL_HOSTS.has(new URL(String(v).trim()).hostname); } catch { return false; }
  };
  function sttMode(s = {}) {
    if (s.sttMode === 'builtin' && !globalThis.desktop) return 'whisper-local';
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
    if (mode === 'builtin') return { mode: 'http', baseUrl: BUILTIN_URL, apiKey: '', model: DEFAULT_WHISPER_MODEL, language };
    if (mode === 'whisper-local') {
      const ownModel = s.sttModel && s.sttModel !== DEFAULT_API_MODEL && !isDiarizeModel(s.sttModel) && !/^gpt-/i.test(s.sttModel) ? s.sttModel : null;
      return { mode: 'http', baseUrl: sttBase || WHISPER_DEFAULT, apiKey: sttKey, model: ownModel ?? DEFAULT_WHISPER_MODEL, language };
    }
    const model = s.sttModel || DEFAULT_API_MODEL;
    if (sttBase) return { mode: 'http', baseUrl: sttBase, apiKey: sttKey, model, language };
    return { mode: 'http', baseUrl: s.baseUrl, apiKey: sttKey || s.apiKey, model, language };
  }
  const neverConfigured = ({ settings: s = {}, meetings = [] }) => !meetings.length
    && !s.sttMode && !s.sttBaseUrl && !s.apiKey && !s.baseUrl;
  globalThis.MeetStt = {
    parseSttResponse, mergeSttChunks, sttEndpoint, sttMode, isLocalUrl, neverConfigured,
    BUILTIN_URL, WHISPER_DEFAULT, DEFAULT_LANGUAGE, DEFAULT_API_MODEL, createVoiceMemory, sendWithVoices, isDiarizeModel, namesCanMove,
  };
})();
