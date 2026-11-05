(async () => {
  const { el, raw, meetingKey } = globalThis.MeetUi;
  await globalThis.MeetI18n.follow();
  const id = new URLSearchParams(location.search).get('id');
  const key = meetingKey(id);
  const meeting = (await chrome.storage.local.get(key))[key];
  const page = document.getElementById('page');
  if (!meeting) {
    page.append(el('p', null, 'Meeting not found.'));
    return;
  }
  document.title = meeting.title;
  page.append(raw(el('h1', null, meeting.title)), el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));
  if (meeting.mom) page.append(el('h2', null, 'Minutes of Meeting'), raw(el('div', 'mom', meeting.mom)));
  if (meeting.segments.length) page.append(el('h2', null, 'Transcript'));
  for (const s of meeting.segments) {
    const line = raw(el('div', 'seg'));
    const head = el('div');
    head.append(el('span', 'who', s.speaker), el('span', 'time', new Date(s.t).toLocaleTimeString()));
    line.append(head, el('div', null, s.text));
    page.append(line);
  }
  window.print();
})();
