(() => {
  const q = (sels, root = document) => {
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
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
  function captionsRegion() {
    return q(CAPTION_REGION);
  }
  function captionBlocks(region) {
    const blocks = region.querySelectorAll('div.nMcdL');
    if (blocks.length) return [...blocks];
    const texts = region.querySelectorAll('div[jsname="tgaKEf"]');
    if (texts.length) return [...texts].map((t) => t.parentElement);
    return [...region.children].filter((c) => c.querySelector('img'));
  }
  function blockSpeaker(block) {
    const el = q(['.NWpY1d', '.KcIKyf', '.zs7s8d'], block);
    if (el) return el.textContent.trim();
    const img = block.querySelector('img');
    const sib = img && img.nextElementSibling;
    return (sib && sib.textContent.trim()) || 'Unknown';
  }
  function blockText(block) {
    const el = q(['.ygicle', 'div[jsname="tgaKEf"]'], block);
    if (el) return el.textContent.trim();
    const clone = block.cloneNode(true);
    clone.querySelectorAll('img, button, i').forEach((n) => n.remove());
    return clone.textContent.replace(blockSpeaker(block), '').trim();
  }
  function langCombobox() {
    return q([
      'div[jsname="oYxtQd"][role="combobox"]',
      '[role="combobox"][aria-label*="language" i]',
      '[role="combobox"][aria-label*="bahasa" i]',
    ]);
  }
  const LANG_PATTERN = {
    id: /^(bahasa\s+)?indonesian?\b/i,
    en: /^(english|inggris)\b/i,
  };
  function langOption(re) {
    const hits = [...document.querySelectorAll('[role="option"]')]
      .map((o) => [o, o.textContent.trim()])
      .filter(([, t]) => re.test(t));
    hits.sort((a, b) => a[1].length - b[1].length);
    return hits[0]?.[0] ?? null;
  }
  function ccButton() {
    return q([
      'button[jsname="r8qRAd"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="teks" i]',
    ]);
  }
  function ccEnabled() {
    const b = ccButton();
    return !!b && b.getAttribute('aria-pressed') === 'true';
  }
  function inCall() {
    return !!q([
      'button[jsname="CQylAd"]',
      'button[aria-label*="leave call" i]',
      'button[aria-label*="keluar dari panggilan" i]',
    ]);
  }
  function meetingTitle() {
    const t = document.title
      .replace(/^Meet\s*[-–—]\s*/, '')
      .replace(/\s*[-–—]\s*Google Meet\s*$/, '')
      .trim();
    return t && t !== 'Meet' ? t : '';
  }
  globalThis.MeetSelectors = {
    captionsRegion, captionBlocks, blockSpeaker, blockText,
    ccButton, ccEnabled, inCall, meetingTitle, CAPTION_REGION,
    langCombobox, langOption, LANG_PATTERN,
  };
})();
