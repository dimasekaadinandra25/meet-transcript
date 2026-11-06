(async () => {
  const { el, raw, markLine, meetingKey } = globalThis.MeetUi;
  await globalThis.MeetI18n.follow();
  const id = new URLSearchParams(location.search).get('id');
  const key = meetingKey(id);
  const meeting = (await chrome.storage.local.get(key))[key];
  const page = document.getElementById('page');
  if (!meeting) {
    page.append(el('p', null, 'Meeting not found.'));
    return;
  }
  raw(document.querySelector('title'));
  document.title = meeting.title;
  page.append(raw(el('h1', null, meeting.title)), el('p', 'muted', new Date(meeting.startedAt).toLocaleString()));
  if (meeting.mom) page.append(el('h2', null, 'Minutes of Meeting'), raw(el('div', 'mom', meeting.mom)));
  const items = globalThis.MeetMerge.timeline(meeting);
  if (items.length) page.append(el('h2', null, 'Transcript'));
  for (const item of items) {
    if (item.mark) {
      page.append(markLine(item.t));
      continue;
    }
    const line = raw(el('div', 'seg'));
    const head = el('div');
    head.append(el('span', 'who', item.speaker), el('span', 'time', new Date(item.t).toLocaleTimeString()));
    line.append(head, el('div', null, item.text));
    page.append(line);
  }
  await new Promise((resolve) => setTimeout(resolve));
  window.print();
})();
