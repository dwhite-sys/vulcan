import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Session, convertLegacy, decode } from '../session.mjs';
const integration = fileURLToPath(new URL('../vendor/shellIntegration-bash.sh', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await sleep(20); } throw new Error('Timed out'); }
function create(cols = 80) { return new Session({ file: '/bin/bash', args: ['--noprofile', '--rcfile', integration, '-i'], env: { ...process.env, VSCODE_NONCE: 'test-nonce', PS1: '$ ' }, nonce: 'test-nonce', cols, rows: 24, hostCwd: '/tmp' }); }

test('real Bash command completion, environment, exit status, and resize', async () => {
  const session = create();
  try {
    await until(async () => (await session.snapshot()).integration === 'ready');
    await session.execute('first', 'export VULCAN_TEST_STATE=retained; printf "hello\\n"; false');
    const first = await until(async () => { const c = (await session.snapshot()).commands[0]; return c?.state === 'completed' && c; });
    assert.equal(first.exitCode, 1);
    assert.match(first.output, /hello/);
    assert.doesNotMatch(first.output, /\x1b/);
    await session.resize(41, 17);
    await session.execute('second', 'printf "%s\\n" "$VULCAN_TEST_STATE"; stty size');
    const second = await until(async () => { const c = (await session.snapshot()).commands[1]; return c?.state === 'completed' && c; });
    assert.match(second.output, /retained/);
    assert.match(second.output, /17 41/);
    assert.equal((await session.snapshot()).cols, 41);
  } finally { await session.close(); }
});

test('history conversion never sends terminal reports to a shell', async () => {
  const converted = await convertLegacy('valid\r\n\x1b[c\x1b[6n\x1b]10;?\x07');
  assert.match(converted.data, /valid/);
  assert.doesNotMatch(converted.data, /1;2c|0;276;0c/);
});

test('session restore keeps historical queries out of live shell input', async () => {
  const session = new Session({ file: '/bin/bash', args: ['--noprofile', '--rcfile', integration, '-i'], env: { ...process.env, VSCODE_NONCE: 'test-nonce' }, nonce: 'test-nonce', cols: 72, rows: 20, hostCwd: '/tmp' }, { cols: 80, rows: 24, data: 'historical\r\n\x1b[c\x1b[6n' });
  try {
    await until(async () => (await session.snapshot()).integration === 'ready');
    const snapshot = await session.snapshot();
    assert.match(snapshot.data, /historical/);
    assert.doesNotMatch(snapshot.data, /command not found|1;2c/);
    await assert.rejects(session.resize(0, 0), /Invalid/);
  } finally { await session.close(); }
});

// Copyright (c) Microsoft Corporation. MIT; see vendor/LICENSE.vscode.
// Adapted upstream OSC deserialization cases at the pinned VS Code revision.
const Backslash = '\\';
const Newline = '\n';
const Semicolon = ';';
const cases = [
			['empty', '', ''],
			['basic', 'value', 'value'],
			['space', 'some thing', 'some thing'],
			['escaped backslash', `${Backslash}${Backslash}`, Backslash],
			['non-initial escaped backslash', `foo${Backslash}${Backslash}`, `foo${Backslash}`],
			['two escaped backslashes', `${Backslash}${Backslash}${Backslash}${Backslash}`, `${Backslash}${Backslash}`],
			['escaped backslash amidst text', `Hello${Backslash}${Backslash}there`, `Hello${Backslash}there`],
			['backslash escaped literally and as hex', `${Backslash}${Backslash} is same as ${Backslash}x5c`, `${Backslash} is same as ${Backslash}`],
			['escaped semicolon', `${Backslash}x3b`, Semicolon],
			['non-initial escaped semicolon', `foo${Backslash}x3b`, `foo${Semicolon}`],
			['escaped semicolon (upper hex)', `${Backslash}x3B`, Semicolon],
			['escaped backslash followed by literal "x3b" is not a semicolon', `${Backslash}${Backslash}x3b`, `${Backslash}x3b`],
			['non-initial escaped backslash followed by literal "x3b" is not a semicolon', `foo${Backslash}${Backslash}x3b`, `foo${Backslash}x3b`],
			['escaped backslash followed by escaped semicolon', `${Backslash}${Backslash}${Backslash}x3b`, `${Backslash}${Semicolon}`],
			['escaped semicolon amidst text', `some${Backslash}x3bthing`, `some${Semicolon}thing`],
			['escaped newline', `${Backslash}x0a`, Newline],
			['non-initial escaped newline', `foo${Backslash}x0a`, `foo${Newline}`],
			['escaped newline (upper hex)', `${Backslash}x0A`, Newline],
			['escaped backslash followed by literal "x0a" is not a newline', `${Backslash}${Backslash}x0a`, `${Backslash}x0a`],
			['non-initial escaped backslash followed by literal "x0a" is not a newline', `foo${Backslash}${Backslash}x0a`, `foo${Backslash}x0a`],
			['PS1 simple', '[\\u@\\h \\W]\\$', '[\\u@\\h \\W]\\$'],
			['PS1 VSC SI', `${Backslash}x1b]633;A${Backslash}x07\\[${Backslash}x1b]0;\\u@\\h:\\w\\a\\]${Backslash}x1b]633;B${Backslash}x07`, '\x1b]633;A\x07\\[\x1b]0;\\u@\\h:\\w\\a\\]\x1b]633;B\x07']
		];
for (const [title, input, expected] of cases) test('upstream OSC: ' + title, () => assert.equal(decode(input), expected));

test('multiline commands, rendered progress, and private password takeover share the shell', async () => {
  const session = create(35);
  try {
    await until(async () => (await session.state()).integration === 'ready');
    await session.execute('multiline', 'cat <<\'END\'\nUnicode café 世界\nEND\nprintf "\\033[31mred\\033[0m\\rreplaced\\n"; false');
    const multiline = await until(async () => { const c = (await session.state()).commands[0]; return c?.state === 'completed' && c; });
    assert.match(multiline.output, /Unicode café 世界/);
    assert.match(multiline.output, /replaced/);
    assert.doesNotMatch(multiline.output, /\x1b/);
    assert.equal(multiline.exitCode, 1);
    await session.execute('password', 'read -s -p "password:" answer; printf "\\nlength=%s\\n" "${#answer}"');
    await until(async () => (await session.state()).commands[1]?.output.includes('password:'));
    await session.input('private-secret\n');
    const password = await until(async () => { const c = (await session.state()).commands[1]; return c?.state === 'completed' && c; });
    assert.match(password.output, /length=14/);
    assert.doesNotMatch(password.output, /private-secret/);
    await session.execute('interrupt', 'sleep 30');
    await until(async () => (await session.state()).busy);
    // C marks shell execution before Bash has assigned the child's foreground
    // process group. Interrupt only once the real sleep process owns the PTY.
    await until(() => Number(execFileSync('ps', ['-o', 'tpgid=', '-p', String(session.proc.pid)], { encoding: 'utf8' }).trim()) !== session.proc.pid);
    await session.input('\x03');
    const interrupted = await until(async () => { const c = (await session.state()).commands[2]; return c?.state === 'completed' && c; });
    assert.equal(interrupted.exitCode, 130);
    await session.execute('after', 'printf "after-interrupt\\n"');
    await until(async () => (await session.state()).commands[3]?.state === 'completed');
  } finally { await session.close(); }
});

test('full-screen Vim survives resizing and returns to the integrated shell', async t => {
  try { execFileSync('vim', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('Vim unavailable'); return; }
  const session = create(80);
  try {
    await until(async () => (await session.state()).integration === 'ready');
    await session.execute('editor', 'vim -Nu NONE -n -i NONE');
    await until(() => session.term.buffer.active.type === 'alternate');
    await session.resize(42, 15);
    await session.input('iUnicode café 世界');
    await until(async () => (await session.snapshot()).text.includes('Unicode café 世界'));
    const live = await session.snapshot();
    assert.match(live.text, /Unicode café 世界/);
    assert.equal(live.cols, 42);
    assert.equal(live.rows, 15);
    const durable = await session.snapshot(true);
    assert.doesNotMatch(durable.data, /Unicode café 世界/);
    await session.input('\x1b:q!\r');
    await until(async () => (await session.state()).commands[0]?.state === 'completed');
    assert.equal(session.term.buffer.active.type, 'normal');
    await session.execute('after-editor', 'printf "editor-exited\\n"');
    await until(async () => (await session.state()).commands[1]?.state === 'completed');
  } finally { await session.close(); }
});


test('exiting the shell preserves its command exit status', async () => {
  const session = create();
  try {
    await until(async () => (await session.state()).integration === 'ready');
    await session.execute('exit-status', 'exit 42');
    const state = await until(async () => { const value = await session.state(); return value.finished && value; });
    assert.equal(state.commands[0].exitCode, 42);
    assert.equal(state.commands[0].state, 'completed');
  } finally { await session.close(); }
});
