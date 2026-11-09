(() => {
  // Returns the first element matching any of the selectors, skipping selectors the browser rejects.
  const firstMatch = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const element = root.querySelector(selector);
        if (element) return element;
      } catch {}
    }
    return null;
  };

  const CAPTION_REGION = [
    'div[jsname="dsyhDe"]',
    'div[aria-label="Captions"]',
    'div[aria-label="Teks"]',
    '.a4cQT',
  ];

  // Finds the area of the Meet page that shows live captions.
  function captionsRegion() {
    return firstMatch(CAPTION_REGION);
  }

  // Lists the caption blocks (one per speaker turn) inside the captions area.
  function captionBlocks(region) {
    const blocks = region.querySelectorAll('div.nMcdL');
    if (blocks.length) return [...blocks];
    const texts = region.querySelectorAll('div[jsname="tgaKEf"]');
    if (texts.length) return [...texts].map((text) => text.parentElement);
    return [...region.children].filter((child) => child.querySelector('img'));
  }

  // Reads the speaker name of a caption block, or 'Unknown' when none is shown.
  function blockSpeaker(block) {
    const nameElement = firstMatch(['.NWpY1d', '.KcIKyf', '.zs7s8d'], block);
    if (nameElement) return nameElement.textContent.trim();
    const avatar = block.querySelector('img');
    const besideAvatar = avatar && avatar.nextElementSibling;
    return (besideAvatar && besideAvatar.textContent.trim()) || 'Unknown';
  }

  // Reads the spoken text of a caption block without the speaker name.
  function blockText(block) {
    const textElement = firstMatch(['.ygicle', 'div[jsname="tgaKEf"]'], block);
    if (textElement) return textElement.textContent.trim();
    const clone = block.cloneNode(true);
    clone.querySelectorAll('img, button, i').forEach((node) => node.remove());
    return clone.textContent.replace(blockSpeaker(block), '').trim();
  }

  // Finds the caption language dropdown in Meet's settings.
  function langCombobox() {
    return firstMatch([
      'div[jsname="oYxtQd"][role="combobox"]',
      '[role="combobox"][aria-label*="language" i]',
      '[role="combobox"][aria-label*="bahasa" i]',
    ]);
  }

  // Builds a case-insensitive pattern matching text that starts with any of the names.
  const named = (...names) => new RegExp(`^(${names.join('|')})`, 'i');

  const LANG_PATTERN = {
    id: /^(bahasa\s+)?indonesian?\b/i,
    en: /^(english|inggris)\b/i,
    ms: named('malay\\b', 'melayu', 'bahasa melayu'),
    zh: named('chinese', 'mandarin', 'tionghoa', 'cina', '中文'),
    ja: named('japanese', 'jepang', '日本語'),
    ko: named('korean', 'korea', '한국어'),
    hi: named('hindi', 'हिन्दी'),
    ar: named('arabic', 'arab', 'العربية'),
    es: named('spanish', 'spanyol', 'español'),
    fr: named('french', 'prancis', 'français'),
    de: named('german', 'jerman', 'deutsch'),
    pt: named('portuguese', 'portugis', 'português'),
  };

  // Picks the shortest open dropdown option whose text matches the language pattern.
  function langOption(pattern) {
    const hits = [...document.querySelectorAll('[role="option"]')]
      .map((option) => ({ option, text: option.textContent.trim() }))
      .filter(({ text }) => pattern.test(text));
    hits.sort((a, b) => a.text.length - b.text.length);
    return hits[0]?.option ?? null;
  }

  // Finds the button that turns Meet captions on or off.
  function ccButton() {
    return firstMatch([
      'button[jsname="r8qRAd"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="teks" i]',
    ]);
  }

  // Tells whether Meet captions are switched on.
  function ccEnabled() {
    const button = ccButton();
    return !!button && button.getAttribute('aria-pressed') === 'true';
  }

  // Tells whether the user is in a call, by looking for the leave-call button.
  function inCall() {
    return !!firstMatch([
      'button[jsname="CQylAd"]',
      'button[aria-label*="leave call" i]',
      'button[aria-label*="keluar dari panggilan" i]',
    ]);
  }

  // Returns the meeting name from the tab title, or '' when Meet shows no name.
  function meetingTitle() {
    const title = document.title
      .replace(/^Meet\s*[-–—]\s*/, '')
      .replace(/\s*[-–—]\s*Google Meet\s*$/, '')
      .trim();
    return title && title !== 'Meet' ? title : '';
  }

  globalThis.MeetSelectors = {
    captionsRegion, captionBlocks, blockSpeaker, blockText,
    ccButton, ccEnabled, inCall, meetingTitle, CAPTION_REGION,
    langCombobox, langOption, LANG_PATTERN,
  };
})();
