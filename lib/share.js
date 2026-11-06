(() => {
  const SLACK_URL = /^https:\/\/hooks\.slack\.com\/services\//;
  const NOTION_PAGES_URL = 'https://api.notion.com/v1/pages';
  const NOTION_VERSION = '2022-06-28';
  const NOTION_PAGE_ID = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[?#].*)?$/i;
  const NOTION_MAX_BLOCKS = 100;
  const NOTION_MAX_TEXT = 1900;
  const SLACK_MAX_TEXT = 39000;
  const EMAIL_MAX_BODY = 1400;
  const EMAIL_MAX_SUBJECT = 300;
  const SHORTENED = '(shortened)';
  const SEND_TIMEOUT_MS = 30000;

  function encodedPrefix(text, max) {
    let out = '';
    let size = 0;
    for (const char of text.toWellFormed()) {
      const encoded = encodeURIComponent(char);
      if (size + encoded.length > max) return { out, cut: true };
      out += encoded;
      size += encoded.length;
    }
    return { out, cut: false };
  }

  function emailUrl({ title, mom }) {
    const subject = encodedPrefix(title, EMAIL_MAX_SUBJECT).out;
    const { out, cut } = encodedPrefix(mom, EMAIL_MAX_BODY);
    const note = cut ? encodeURIComponent('…\n\n(The full MoM is on your clipboard. Paste it here.)') : '';
    return `mailto:?subject=${subject}&body=${out}${note}`;
  }

  const slackText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function slackRequest({ webhook }, { title, mom }) {
    if (!SLACK_URL.test(webhook ?? '')) throw new Error('Add your Slack webhook address in Settings. It starts with https://hooks.slack.com/services/.');
    return { url: webhook, headers: {}, body: { text: `*${slackText(title)}*\n\n${slackText(mom)}`.slice(0, SLACK_MAX_TEXT).toWellFormed() } };
  }

  const paragraph = (content) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } });

  function notionBlocks(mom) {
    const pieces = mom.split(/\r?\n/).filter((line) => line.trim())
      .flatMap((line) => line.toWellFormed().match(new RegExp(`.{1,${NOTION_MAX_TEXT / 2}}`, 'gsu')) ?? []);
    if (pieces.length <= NOTION_MAX_BLOCKS) return pieces.map(paragraph);
    return [...pieces.slice(0, NOTION_MAX_BLOCKS - 1), SHORTENED].map(paragraph);
  }

  function notionRequest({ token, page }, { title, mom }) {
    const pageId = String(page ?? '').trim().match(NOTION_PAGE_ID)?.[1].replace(/-/g, '');
    if (!token || !pageId) throw new Error('Add your Notion token and page link in Settings.');
    return {
      url: NOTION_PAGES_URL,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
      body: { parent: { page_id: pageId }, properties: { title: { title: [{ text: { content: title } }] } }, children: notionBlocks(mom) },
    };
  }

  const REQUESTS = {
    slack: (settings, meeting) => slackRequest({ webhook: settings.slackWebhook }, meeting),
    notion: (settings, meeting) => notionRequest({ token: settings.notionToken, page: settings.notionPage }, meeting),
  };

  async function deliver(kind, settings, meeting, request = fetch) {
    if (!Object.hasOwn(REQUESTS, kind)) throw new Error('Unknown destination.');
    if (!meeting.mom) throw new Error('Make the MoM first.');
    const { url, headers, body } = REQUESTS[kind](settings, meeting);
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`The MoM could not be sent (HTTP ${res.status}).`);
  }

  globalThis.MeetShare = { deliver, emailUrl, notionRequest, slackRequest };
})();
