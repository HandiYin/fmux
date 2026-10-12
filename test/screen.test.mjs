import assert from 'node:assert/strict';
import test from 'node:test';
import { compactScreen, findDialog, keysFor, looksWorking } from '../src/screen.mjs';

const PERMISSION = `
● I'll remove the folder.

────────────────────────────────────────────────────────────
 Bash command

   rm -rf build
   Remove the build folder

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /home/ubuntu
   3. No, and tell Claude what to do differently (esc)
`;

const TRUST = `
 Accessing workspace:

 /tmp/project

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const INPUT_BOX = `
● Done.

────────────────────────────────────────────────────────────
❯ first line of a long prompt
  second line of the prompt
────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on · esc to interrupt
`;

test('numbered permission dialog', () => {
  const dialog = findDialog(PERMISSION);
  assert.equal(dialog.numbered, true);
  assert.deepEqual(dialog.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(dialog.options[0].selected, true);
  assert.match(dialog.question, /Do you want to proceed\?/);
  assert.deepEqual(keysFor(dialog, 2), ['3']);
});

test('numbered options with descriptions under them', () => {
  const dialog = findDialog(`
 Which library?
 ❯ 1. Day.js
      Small and fast
   2. Luxon
      Timezone aware
   3. Type something.
`);
  assert.equal(dialog.options.length, 3);
  assert.equal(dialog.options[1].label, 'Luxon');
});

test('cursor menu without numbers needs arrow keys', () => {
  const dialog = findDialog(TRUST);
  assert.equal(dialog.numbered, false);
  assert.deepEqual(dialog.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.deepEqual(keysFor(dialog, 1), ['down', 'enter']);
  assert.deepEqual(keysFor(dialog, 0), ['enter']);
});

test('cursor menu with the cursor on a later option moves up', () => {
  const dialog = findDialog(TRUST.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust'));
  assert.deepEqual(keysFor(dialog, 0), ['up', 'enter']);
});

test('an input box and a plain numbered list are not dialogs', () => {
  assert.equal(findDialog(INPUT_BOX), null);
  assert.equal(findDialog('Steps:\n 1. build\n 2. test\n 3. ship\n'), null);
});

test('working marker', () => {
  assert.equal(looksWorking(INPUT_BOX), true);
  assert.equal(looksWorking('$ ls\nfile.txt\n$ '), false);
  assert.equal(looksWorking(' Took 4.0s\n── ⠴ Working ────────\n/home/u\n↑3.1k ↓24 $0.016'), true);
  assert.equal(looksWorking('The agent said: Working... on it\n› Ask Codex to do anything'), false);
});

test('compactScreen keeps the tail, shortens rules and long lines', () => {
  const screen = ['a', '', '', '', '─'.repeat(80), 'x'.repeat(300), ...Array.from({ length: 50 }, (_, i) => `line ${i}`)].join('\n');
  const out = compactScreen(screen, 10, 40).split('\n');
  assert.equal(out.length, 10);
  assert.equal(out.at(-1), 'line 49');
  const head = compactScreen('─'.repeat(80) + '\n' + 'x'.repeat(300), 10, 40).split('\n');
  assert.equal(head[0], '────────');
  assert.equal(Array.from(head[1]).length, 41);
});
