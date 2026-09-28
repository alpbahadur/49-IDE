import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TTYD_BIND_HOST,
  buildTtydArgs,
  ttydUrl,
} from '../src/ttydLaunch.js';

/**
 * ttyd serves a writable shell. These tests pin down who can reach it.
 */

// --- Arguments ---------------------------------------------------------------

test('ttyd binds to loopback only', () => {
  const args = buildTtydArgs({ port: 7700, command: ['cat'] });
  const i = args.indexOf('-i');
  assert.notEqual(i, -1, 'ttyd must be given -i, or it listens on every interface');
  assert.equal(args[i + 1], '127.0.0.1');
  assert.equal(TTYD_BIND_HOST, '127.0.0.1');
});

test('the wrapped command comes last, so ttyd does not parse its flags', () => {
  const command = ['tmux', 'attach-session', '-t', 'sess'];
  const args = buildTtydArgs({ port: 7700, command });
  assert.deepEqual(args.slice(-command.length), command);
});

test('the agent connects over loopback', () => {
  assert.equal(ttydUrl(7700), 'ws://127.0.0.1:7700/ws');
});
