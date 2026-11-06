(() => {
  const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const TITLE_SIZE = 36;
  const HEADING_SIZE = 28;

  const escapeXml = (text) => String(text ?? '')
    .replace(/[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function run(text, { bold = false, size = null } = {}) {
    const props = `${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}`;
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  }
  const paragraph = (...runs) => `<w:p>${runs.join('')}</w:p>`;

  function documentXml(meeting) {
    const t = globalThis.MeetI18n?.t ?? String;
    const body = [
      paragraph(run(meeting.title, { bold: true, size: TITLE_SIZE })),
      paragraph(run(new Date(meeting.startedAt).toLocaleString())),
    ];
    if (meeting.mom) {
      body.push(paragraph(run(t('Minutes of Meeting'), { bold: true, size: HEADING_SIZE })));
      for (const line of meeting.mom.split('\n')) body.push(paragraph(run(line)));
    }
    if (meeting.segments.length) {
      body.push(paragraph(run(t('Transcript'), { bold: true, size: HEADING_SIZE })));
      for (const s of meeting.segments) {
        const time = run(`[${globalThis.MeetMerge.timeOf(s.t)}] `);
        body.push(s.speaker
          ? paragraph(time, run(`${s.speaker}: `, { bold: true }), run(s.text))
          : paragraph(time, run(s.text)));
      }
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body.join('')}</w:body></w:document>`;
  }

  async function makeDocx(meeting) {
    const zip = await globalThis.MeetBackup.makeZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS },
      { name: 'word/document.xml', data: documentXml(meeting) },
    ]);
    return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  globalThis.MeetExport = { makeDocx };
})();
