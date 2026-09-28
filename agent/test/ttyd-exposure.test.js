import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import WebSocket from 'ws';
import {
  TTYD_BIND_HOST,
  buildTtydArgs,
  ttydUrl,
} from '../src/ttydLaunch.js';

/**
 * ttyd serves a writable shell. These tests pin down who can reach it.
 *
 * The integration tests launch a real ttyd with the agent's arguments, with
 * `cat` standing in for `tmux attach-session`, and try to type into it the way
 * an attacker would. They skip when ttyd is not installed.
 */

const hasTtyd = spawnSync('ttyd', ['--version']).status === 0;
const PORT = 47850;

function startTtyd(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ttyd', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('ttyd startup timeout')); }, 5000);
    proc.stderr.on('data', (data) => {
      if (data.toString().includes('Listening on')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.on('error', reject);
  });
}

function stopTtyd(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
    proc.kill();
  });
}

/**
 * Connect, send a line of input and report whether it came back. Resolves
 * { typed: true } only if the terminal accepted and echoed the input.
 */
function tryToType(url, wsOptions = {}) {
  return new Promise((resolve) => {
    const marker = `probe-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocket(url, ['tty'], { handshakeTimeout: 1500, ...wsOptions });
    let output = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ typed: false, reason: 'no echo' }), 2000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ columns: 80, rows: 24 }));
      ws.send(Buffer.from(`0${marker}\n`));
    });
    ws.on('message', (data) => {
      const buf = Buffer.from(data);
      if (buf[0] === 0x30) output += buf.subarray(1).toString();
      if (output.includes(marker)) finish({ typed: true });
    });
    ws.on('error', (err) => finish({ typed: false, reason: err.code || err.message }));
    ws.on('close', () => finish({ typed: false, reason: 'closed' }));
  });
}

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

// --- Real ttyd ---------------------------------------------------------------

test('real ttyd with the agent arguments', { skip: !hasTtyd && 'ttyd not installed' }, async (t) => {
  const proc = await startTtyd(buildTtydArgs({ port: PORT, command: ['cat'] }));
  t.after(() => stopTtyd(proc));

  await t.test('the agent can type into the terminal', async () => {
    const result = await tryToType(ttydUrl(PORT));
    assert.equal(result.typed, true, `agent client failed: ${result.reason}`);
  });
});
