(() => {
  const SOUND_MARKER = /^(?:\s|♪|\[[^\]]*\]|\([^)]*\))*$/;

  // Says whether a text holds real words rather than only sound markers like [music].
  const isSpoken = (text) => !SOUND_MARKER.test(text ?? '');

  // Turns an error value from a speech-to-text reply into readable text.
  function errorText(error) {
    if (typeof error === 'string') return error;
    return error?.message ? String(error.message) : JSON.stringify(error);
  }

  // Reads a speech-to-text reply into a list of spoken segments, or an error.
  function parseSttResponse(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return { segments: [] };
    }
    if (data && Array.isArray(data.segments) && data.segments.length) {
      const segments = data.segments.filter((seg) => isSpoken(seg.text)).map((seg) => ({
        start: seg.start ?? 0,
        ...(seg.end === undefined ? {} : { end: seg.end }),
        text: seg.text ?? '',
        ...(seg.speaker ? { speaker: String(seg.speaker) } : {}),
      }));
      return { segments };
    }
    if (data && typeof data.text === 'string' && data.text.trim()) {
      return { segments: isSpoken(data.text) ? [{ start: 0, text: data.text }] : [] };
    }
    if (data && data.error) return { error: errorText(data.error) };
    return { segments: [] };
  }

  // Turns per-chunk speech-to-text results into timed transcript lines.
  function mergeSttChunks(chunkResults, chunkDurationMs, baseTime, indices) {
    const out = [];
    const chunkIndices = indices?.length === chunkResults.length ? indices : null;
    chunkResults.forEach((result, i) => {
      const offset = baseTime + (chunkIndices ? chunkIndices[i] : i) * chunkDurationMs;
      if (!result || result.error) {
        out.push({ t: offset, speaker: '', text: '[transcript failed]', failedUntil: offset + chunkDurationMs });
        return;
      }
      for (const seg of result.segments ?? []) {
        const text = (seg.text ?? '').trim();
        if (!text) continue;
        let speaker = '';
        if (seg.speaker) speaker = seg.named ? seg.speaker : `Speaker ${seg.speaker}`;
        out.push({
          t: offset + Math.round((seg.start ?? 0) * 1000),
          speaker,
          text,
          ...(seg.named ? { matched: true } : {}),
        });
      }
    });
    return out;
  }

  const VOICE_PREFIX = 'Voice ';
  const MAX_KNOWN_VOICES = 4;
  const MIN_CLIP_SECONDS = 2;
  const MAX_CLIP_SECONDS = 6;

  // Says whether a speech-to-text model tells speakers apart.
  const isDiarizeModel = (model) => /diarize/i.test(model ?? '');

  // Creates a memory of speaker voices so later chunks keep the same speaker letters.
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
        const longEnough = seg.end - seg.start >= MIN_CLIP_SECONDS;
        if (!unknown || known.length >= MAX_KNOWN_VOICES || !longEnough) continue;
        const clipEnd = Math.min(seg.end, seg.start + MAX_CLIP_SECONDS);
        const clip = await makeClip(seg.start, clipEnd).catch(() => null);
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

  // Sends audio with the known voices, retrying without them if the server rejects them.
  async function sendWithVoices({ send, blob, voices, makeClip }) {
    const references = voices.references();
    const result = await send(references).catch((e) => {
      if (!references.length || e.name !== 'RequestRejected') throw e;
      return send([]);
    });
    if (result.error) return result;
    return voices.learn(result, (from, to) => makeClip(blob, from, to));
  }

  // Says whether renamed speakers may land on different people after retranscribing.
  const namesCanMove = (meeting, model) => isDiarizeModel(model)
    && Object.keys(meeting.speakerNames ?? {}).length > 0;

  const MAX_VOCABULARY_CHARS = 500;
  const BUILTIN_URL = 'builtin:';
  const WHISPER_DEFAULT = 'http://localhost:8080/v1';
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const DEFAULT_LANGUAGE = '';
  const DEFAULT_WHISPER_MODEL = 'whisper-1';
  const DEFAULT_API_MODEL = 'nvidia/parakeet-ctc-1.1b-asr';

  // Says whether a URL points at this computer.
  const isLocalUrl = (value) => {
    try {
      return LOCAL_HOSTS.has(new URL(String(value).trim()).hostname);
    } catch {
      return false;
    }
  };

  // Works out which speech-to-text mode the settings use, including older saved settings.
  function sttMode(settings = {}) {
    if (settings.sttMode === 'builtin' && !globalThis.desktop) return 'whisper-local';
    if (settings.sttMode && settings.sttMode !== 'browser') return settings.sttMode;
    const sttBase = (settings.sttBaseUrl || '').trim();
    if (sttBase) return isLocalUrl(sttBase) ? 'whisper-local' : 'api';
    if (settings.sttMode === 'browser') return 'whisper-local';
    return (settings.apiKey || settings.baseUrl) ? 'api' : 'whisper-local';
  }

  // Works out the speech-to-text server, key, model and language from the settings.
  function endpointOf(settings) {
    const mode = sttMode(settings);
    const sttBase = (settings.sttBaseUrl || '').trim();
    const sttKey = (settings.sttApiKey || '').trim();
    const language = settings.sttLanguage ?? DEFAULT_LANGUAGE;
    if (mode === 'builtin') {
      return { mode: 'http', baseUrl: BUILTIN_URL, apiKey: '', model: DEFAULT_WHISPER_MODEL, language };
    }
    if (mode === 'whisper-local') {
      const own = settings.sttModel;
      const ownModelFits = own && own !== DEFAULT_API_MODEL && !isDiarizeModel(own) && !/^gpt-/i.test(own);
      const model = ownModelFits ? own : DEFAULT_WHISPER_MODEL;
      return { mode: 'http', baseUrl: sttBase || WHISPER_DEFAULT, apiKey: sttKey, model, language };
    }
    const model = settings.sttModel || DEFAULT_API_MODEL;
    if (sttBase) return { mode: 'http', baseUrl: sttBase, apiKey: sttKey, model, language };
    return { mode: 'http', baseUrl: settings.baseUrl, apiKey: sttKey || settings.apiKey, model, language };
  }

  // Returns the speech-to-text endpoint, with the custom vocabulary when one is set.
  function sttEndpoint(settings = {}) {
    const endpoint = endpointOf(settings);
    const vocabulary = String(settings.sttVocabulary ?? '').trim().slice(0, MAX_VOCABULARY_CHARS);
    return vocabulary ? { ...endpoint, vocabulary } : endpoint;
  }

  // Says whether this is a fresh install with no meetings and no speech-to-text setup.
  const neverConfigured = ({ settings, meetings = [] }) => !meetings.length
    && !settings?.sttMode && !settings?.sttBaseUrl && !settings?.apiKey && !settings?.baseUrl;

  globalThis.MeetStt = {
    parseSttResponse, mergeSttChunks, sttEndpoint, sttMode, isLocalUrl, neverConfigured,
    BUILTIN_URL, WHISPER_DEFAULT, DEFAULT_LANGUAGE, DEFAULT_API_MODEL,
    createVoiceMemory, sendWithVoices, isDiarizeModel, namesCanMove,
  };
})();
