import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/share.js');
const { deliver, emailUrl, notionRequest, slackRequest } = globalThis.MeetShare;

const meeting = { title: 'Rapat & anggaran', mom: '## Context\nKita mulai.\n\n## Discussion\nAnggaran naik.' };

test('an email draft carries the title and the MoM', () => {
  const url = emailUrl(meeting);
  assert.ok(url.startsWith('mailto:?subject='));
  const params = new URLSearchParams(url.slice('mailto:?'.length));
  assert.equal(params.get('subject'), 'Rapat & anggaran');
  assert.match(params.get('body'), /Anggaran naik/);
});

test('a long email draft is shortened and says the full text is copied', () => {
  const url = emailUrl({ title: 't', mom: 'x'.repeat(9000) });
  assert.ok(url.length < 2500, `length ${url.length}`);
  assert.match(decodeURIComponent(url), /clipboard/);
});

test('Slack gets the title and the MoM', () => {
  const { url, body } = slackRequest({ webhook: 'https://hooks.slack.com/services/A/B/C' }, meeting);
  assert.equal(url, 'https://hooks.slack.com/services/A/B/C');
  assert.match(body.text, /Rapat &amp; anggaran/);
  assert.match(body.text, /Anggaran naik/);
});

test('a Slack address on another server is refused, so the MoM cannot go elsewhere', () => {
  for (const webhook of ['https://evil.example/services/A', 'http://hooks.slack.com/services/A', 'https://hooks.slack.com.evil.example/services/A', '']) {
    assert.throws(() => slackRequest({ webhook }, meeting), /Slack/);
  }
});

test('Notion gets a page under the chosen parent, always at Notion', () => {
  const { url, headers, body } = notionRequest({ token: 'secret', page: 'https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef' }, meeting);
  assert.equal(url, 'https://api.notion.com/v1/pages');
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.ok(headers['Notion-Version']);
  assert.equal(body.parent.page_id, '0123456789abcdef0123456789abcdef');
  assert.equal(body.properties.title.title[0].text.content, 'Rapat & anggaran');
  assert.ok(body.children.some((block) => JSON.stringify(block).includes('Anggaran naik')));
});

test('Notion limits are respected for long text', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `baris ${i}`).join('\n');
  const { body } = notionRequest({ token: 't', page: '0123456789abcdef0123456789abcdef' }, { title: 't', mom: `${'x'.repeat(5000)}\n${lines}` });
  assert.ok(body.children.length <= 100);
  for (const block of body.children) assert.ok(block.paragraph.rich_text[0].text.content.length <= 2000);
  assert.ok(body.children.at(-1).paragraph.rich_text[0].text.content.includes('shortened'));
});

test('Notion needs a token and a page', () => {
  assert.throws(() => notionRequest({ token: '', page: '0123456789abcdef0123456789abcdef' }, meeting), /Notion/);
  assert.throws(() => notionRequest({ token: 't', page: 'not a page' }, meeting), /Notion/);
});

test('sending posts JSON and reports a rejected request', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"message":"nope"}', { status: 401 });
  };
  await assert.rejects(deliver('slack', { slackWebhook: 'https://hooks.slack.com/services/A/B/C' }, meeting, request), /401/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.match(JSON.parse(calls[0].init.body).text, /Anggaran/);
});

test('an unknown destination and an empty MoM are refused', async () => {
  await assert.rejects(deliver('email', {}, meeting, async () => new Response('')), /destination/i);
  await assert.rejects(deliver('slack', { slackWebhook: 'https://hooks.slack.com/services/A' }, { title: 't', mom: '' }, async () => new Response('')), /MoM/);
});

test('an emoji at the cut does not break the email draft', () => {
  const url = emailUrl({ title: 't', mom: `${'x'.repeat(1499)}😀${'y'.repeat(500)}` });
  assert.ok(url.startsWith('mailto:'));
  decodeURIComponent(url);
});

test('long non-English email drafts stay within what Windows can open', () => {
  assert.ok(emailUrl({ title: 'タイトル'.repeat(100), mom: '日本語'.repeat(5000) }).length < 2083);
  assert.ok(emailUrl({ title: 't', mom: 'kita mulai rapat anggaran hari ini dan besok '.repeat(200) }).length < 2083);
});

test('Slack text cannot ping a channel or disguise a link', () => {
  const { body } = slackRequest({ webhook: 'https://hooks.slack.com/services/A' }, { title: '<!channel> A & B', mom: '<https://evil.example|Open>' });
  assert.doesNotMatch(body.text, /<!channel>|<https/);
  assert.match(body.text, /&lt;!channel&gt; A &amp; B/);
});

test('Notion pieces never split an emoji', () => {
  const { body } = notionRequest({ token: 't', page: '0123456789abcdef0123456789abcdef' }, { title: 't', mom: '😀'.repeat(3000) });
  for (const block of body.children) assert.equal(block.paragraph.rich_text[0].text.content.isWellFormed(), true);
});
