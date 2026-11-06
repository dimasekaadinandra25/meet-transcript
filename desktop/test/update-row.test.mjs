import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../renderer/update-row.js');
const { createUpdateRow } = globalThis;

function setup(answer) {
  const buttons = [];
  const opened = [];
  const box = createUpdateRow({
    el: (_tag, cls) => ({ cls, textContent: '', append(child) { this.child = child; } }),
    mkBtn: (label, fn) => {
      const button = { label, fn, disabled: false };
      buttons.push(button);
      return button;
    },
    check: async () => answer,
    open: () => opened.push('page'),
  });
  return { box, buttons, opened, press: () => buttons[0].fn() };
}

test('a new version offers one download button, however many times you check', async () => {
  const { buttons, opened, press } = setup({ status: 'available', latest: '1.2.3' });
  await press();
  await press();
  await press();
  assert.deepEqual(buttons.map((b) => b.label), ['Check for updates', 'Open download page']);
  buttons[1].fn();
  assert.deepEqual(opened, ['page']);
});

test('the note says what the check found', async () => {
  const noteAfter = async (answer) => {
    const { box, press } = setup(answer);
    await press();
    return box.child.textContent;
  };
  assert.equal(await noteAfter({ status: 'available', latest: '1.2.3' }), 'Version 1.2.3 is available.');
  assert.equal(await noteAfter({ status: 'current' }), 'You have the latest version.');
  assert.equal(await noteAfter({ status: 'none' }), 'No releases have been published yet.');
  assert.equal(await noteAfter({ status: 'failed', error: 'offline' }), 'Could not check for updates (offline).');
});

test('no download button when you already have the latest version', async () => {
  const { buttons, press } = setup({ status: 'current' });
  await press();
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].disabled, false);
});
