import assert from 'node:assert/strict';
import test from 'node:test';

import { focusOf, HOTKEYS, keyAction, KEYS_SETTLE_MS } from '../src/client/hotkeys.ts';
import type { KeyPress, KeyScene } from '../src/client/hotkeys.ts';

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({ key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...more });

/** A turn where every button is showing and free, drawn long enough ago to be seen. */
const turn = (more: Partial<KeyScene> = {}): KeyScene => ({
  enabled: true,
  focus: 'table',
  dialogOpen: false,
  keys: new Set(['F', 'C', 'R', '1', '2', '3', '4', '5']),
  sinceDrawn: KEYS_SETTLE_MS,
  ...more,
});

test('on the table, F and C press their buttons, R goes to the amount and the number keys pick the sizes', () => {
  assert.deepEqual(keyAction(press('f'), turn()), { kind: 'press', key: 'F' });
  assert.deepEqual(keyAction(press('c'), turn()), { kind: 'press', key: 'C' });
  assert.deepEqual(keyAction(press('r'), turn()), { kind: 'aim' });
  assert.deepEqual(keyAction(press('3'), turn()), { kind: 'press', key: '3' });
});

test('a letter counts whatever case it is typed in, so Shift or Caps Lock changes nothing', () => {
  assert.deepEqual(keyAction(press('F'), turn()), { kind: 'press', key: 'F' });
  assert.deepEqual(keyAction(press('R'), turn()), { kind: 'aim' });
});

test('the question of how many times to run it takes O, T and 3', () => {
  const vote = turn({ keys: new Set(HOTKEYS.runs) });

  assert.deepEqual(keyAction(press('o'), vote), { kind: 'press', key: 'O' });
  assert.deepEqual(keyAction(press('t'), vote), { kind: 'press', key: 'T' });
  assert.deepEqual(keyAction(press('3'), vote), { kind: 'press', key: '3' });
  assert.equal(keyAction(press('f'), vote), null, 'a key with no button showing does nothing');
});

test('a key whose button is not showing or is locked does nothing', () => {
  assert.equal(keyAction(press('r'), turn({ keys: new Set(['F', 'C']) })), null, 'R with no raise to make');
  assert.equal(keyAction(press('f'), turn({ keys: new Set() })), null, 'F while a move is on its way');
  assert.equal(keyAction(press('6'), turn()), null);
  assert.equal(keyAction(press('x'), turn()), null);
});

test('keys that are not one character are left to the browser', () => {
  for (const key of ['Enter', 'Escape', 'Tab', 'ArrowLeft', 'F5', ' ']) {
    assert.equal(keyAction(press(key), turn()), null, key);
  }
});

test('a key with Ctrl, Cmd or Alt held is the browser\'s', () => {
  assert.equal(keyAction(press('c', { ctrlKey: true }), turn()), null);
  assert.equal(keyAction(press('r', { metaKey: true }), turn()), null);
  assert.equal(keyAction(press('f', { altKey: true }), turn()), null);
});

test('a key held down acts once', () => {
  assert.equal(keyAction(press('f', { repeat: true }), turn()), null);
});

test('nothing acts while the player is typing, a dialog is open or the shortcuts are off', () => {
  for (const key of ['f', 'c', 'r', '1', 'Enter', 'Escape']) {
    assert.equal(keyAction(press(key), turn({ focus: 'typing' })), null, `${key} while typing`);
    assert.equal(keyAction(press(key), turn({ dialogOpen: true })), null, `${key} with a dialog open`);
    assert.equal(keyAction(press(key), turn({ enabled: false })), null, `${key} switched off`);
  }
});

test('in the raise amount, Enter makes the raise, Escape goes back to the table and the rest is typing', () => {
  const inAmount = turn({ focus: 'amount' });

  assert.deepEqual(keyAction(press('Enter'), inAmount), { kind: 'press', key: 'R' });
  assert.deepEqual(keyAction(press('Escape'), inAmount), { kind: 'leave' });

  for (const key of ['f', 'c', 'r', '1', '3']) {
    assert.equal(keyAction(press(key), inAmount), null, key);
  }

  assert.equal(keyAction(press('Enter'), turn({ focus: 'amount', keys: new Set(['F', 'C']) })), null, 'Enter with the raise button locked');
  assert.equal(keyAction(press('Enter', { repeat: true }), inAmount), null, 'Enter held down raises once');
});

test('a key pressed before the buttons drawn anew can have been seen is ignored, Escape excepted', () => {
  const justDrawn = turn({ sinceDrawn: KEYS_SETTLE_MS - 1 });

  for (const key of ['f', 'c', 'r', '3']) {
    assert.equal(keyAction(press(key), justDrawn), null, key);
  }

  assert.equal(keyAction(press('Enter'), { ...justDrawn, focus: 'amount' }), null);
  assert.deepEqual(keyAction(press('Escape'), { ...justDrawn, focus: 'amount' }), { kind: 'leave' });
  assert.deepEqual(keyAction(press('c'), turn({ sinceDrawn: KEYS_SETTLE_MS })), { kind: 'press', key: 'C' });
});

test('the keyboard is typing in any field that takes text, and on the table anywhere else, the bet slider included', () => {
  const at = (tagName: string, id = '', isContentEditable = false, type?: string) => focusOf({ tagName, id, type, isContentEditable });

  assert.equal(focusOf(null), 'table');
  assert.equal(at('BODY'), 'table');
  assert.equal(at('BUTTON', ''), 'table');
  assert.equal(at('TEXTAREA'), 'typing');
  assert.equal(at('SELECT'), 'typing');
  assert.equal(at('DIV', '', true), 'typing');
  assert.equal(at('INPUT', 'raise-amount'), 'amount');
  assert.equal(at('INPUT', 'raise-slider', false, 'range'), 'table');
  assert.equal(at('INPUT', 'chat-input', false, 'text'), 'typing');
});

test('every key is one character, and no two buttons on one screen share one', () => {
  for (const keys of [[HOTKEYS.fold, HOTKEYS.pass, HOTKEYS.raise, ...HOTKEYS.sizes], [...HOTKEYS.runs]]) {
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every((key) => key.length === 1 && key === key.toUpperCase()));
  }
});
