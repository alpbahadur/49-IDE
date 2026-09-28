import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { networkInterfaces } from 'os';
import WebSocket from 'ws';
import {
  TTYD_BIND_HOST,
  buildTtydArgs,
  generateTtydCredential,
  ttydClientOptions,
  ttydInitMessage,
  ttydUrl,
} from '../src/ttydLaunch.js';

/**
 * ttyd serves a writable shell. These tests pin down who can reach it: only
 * the agent itself, over loopback, holding the per-process credential.
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
function tryToType(url, wsOptions = {}, credential = null) {
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
      // The agent sends its credential in the init message; a client without
      // one sends a plain resize, as ttyd's own web page does.
      ws.send(credential ? ttydInitMessage(credential, 80, 24) : JSON.stringify({ columns: 80, rows: 24 }));
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

function externalIPv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// --- Arguments ---------------------------------------------------------------

test('ttyd binds to loopback only', () => {
  const args = buildTtydArgs({ port: 7700, credential: generateTtydCredential(), command: ['cat'] });
  const i = args.indexOf('-i');
  assert.notEqual(i, -1, 'ttyd must be given -i, or it listens on every interface');
  assert.equal(args[i + 1], '127.0.0.1');
  assert.equal(TTYD_BIND_HOST, '127.0.0.1');
});

test('ttyd requires the generated credential', () => {
  const credential = generateTtydCredential();
  const args = buildTtydArgs({ port: 7700, credential, command: ['cat'] });
  const c = args.indexOf('-c');
  assert.notEqual(c, -1, 'ttyd must be given -c');
  assert.equal(args[c + 1], `${credential.user}:${credential.pass}`);
});

test('the wrapped command comes last, so ttyd does not parse its flags', () => {
  const command = ['tmux', 'attach-session', '-t', 'sess'];
  const args = buildTtydArgs({ port: 7700, credential: generateTtydCredential(), command });
  assert.deepEqual(args.slice(-command.length), command);
});

test('each credential is fresh and unguessable', () => {
  const a = generateTtydCredential();
  const b = generateTtydCredential();
  assert.notEqual(a.pass, b.pass);
  assert.notEqual(a.user, b.user);
  assert.ok(a.pass.length >= 32);
  // ttyd splits "user:pass" on the first colon.
  assert.ok(!a.user.includes(':'));
});

test('the agent connects over loopback and presents the credential', () => {
  const credential = { user: 'u', pass: 'p' };
  const token = Buffer.from('u:p').toString('base64');
  assert.equal(ttydUrl(7700), 'ws://127.0.0.1:7700/ws');
  assert.deepEqual(ttydClientOptions(credential), { headers: { Authorization: `Basic ${token}` } });
  assert.deepEqual(JSON.parse(ttydInitMessage(credential, 120, 40)), { AuthToken: token, columns: 120, rows: 40 });
});

// --- Real ttyd ---------------------------------------------------------------

test('real ttyd with the agent arguments', { skip: !hasTtyd && 'ttyd not installed' }, async (t) => {
  const credential = generateTtydCredential();
  const proc = await startTtyd(buildTtydArgs({ port: PORT, credential, command: ['cat'] }));
  t.after(() => stopTtyd(proc));

  await t.test('the agent can type into the terminal', async () => {
    const result = await tryToType(ttydUrl(PORT), ttydClientOptions(credential), credential);
    assert.equal(result.typed, true, `agent client failed: ${result.reason}`);
  });

  const lanIp = externalIPv4();
  await t.test('another machine on the network cannot connect', { skip: !lanIp && 'no non-loopback IPv4 address' }, async () => {
    // Even holding the credential: the port must not be open on this address.
    const result = await tryToType(`ws://${lanIp}:${PORT}/ws`, ttydClientOptions(credential), credential);
    assert.equal(result.typed, false);
    assert.equal(result.reason, 'ECONNREFUSED');
  });

  await t.test('a local client without the credential is rejected', async () => {
    const result = await tryToType(ttydUrl(PORT));
    assert.equal(result.typed, false);
  });

  await t.test('a wrong credential is rejected', async () => {
    const wrong = { user: credential.user, pass: 'wrong' };
    const result = await tryToType(ttydUrl(PORT), ttydClientOptions(wrong), wrong);
    assert.equal(result.typed, false);
  });

  await t.test('a web page in the user\'s browser cannot connect (cross-site WebSocket)', async () => {
    const result = await tryToType(ttydUrl(PORT), { origin: 'https://attacker.example' });
    assert.equal(result.typed, false);
  });

  await t.test('DNS rebinding (Origin matches Host) is rejected', async () => {
    const host = `attacker.example:${PORT}`;
    const result = await tryToType(ttydUrl(PORT), { origin: `http://${host}`, headers: { Host: host } });
    assert.equal(result.typed, false);
  });
});
