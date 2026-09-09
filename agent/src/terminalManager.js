import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import WebSocket from 'ws';
import { tmuxService } from '../services/tmux.js';
import { config } from './config.js';

// tmux command prefix for this instance (see agent/src/instance.js). A
// non-default instance runs its own tmux server on a dedicated socket
// ('tmux -L <instanceKey>'), so anything that attaches to a session — not
// just tmuxService's own CLI calls — has to name that socket too, or it
// attaches against the default server where the session doesn't exist.
const TMUX = config.tmuxCommand;
const TMUX_ARGS = TMUX.split(' ').slice(1);

// Track ttyd processes by tmux session
const ttydProcesses = new Map();
const usedPorts = new Set();

// Each instance owns a distinct slice of the ttyd range. Startup cleanup below
// reclaims ports in this slice only, so starting a second instance cannot kill
// the terminals of one already running.
const BASE_PORT = config.ttydPortRange.start;
const MAX_PORT = config.ttydPortRange.end;

// Track active terminal connections: terminalId -> { ttydWs, emitter }
const activeTerminals = new Map();

// Guard against concurrent attachTerminal() calls for the same terminalId.
// Stores the in-flight promise so a second caller awaits the first instead of racing.
const pendingAttaches = new Map();

// Batch terminal output over a 10ms window before emitting.
// Collapses many small pty writes into one WebSocket message, which
// dramatically reduces main-thread decode/render work in the browser
// during high-throughput generation (e.g. Claude Code streaming output).
const outputBuffers = new Map(); // terminalId -> Buffer[]
const outputTimers  = new Map(); // terminalId -> timer

function flushOutput(terminalId) {
  const timer = outputTimers.get(terminalId);
  if (timer) { clearTimeout(timer); outputTimers.delete(terminalId); }
  const chunks = outputBuffers.get(terminalId);
  outputBuffers.delete(terminalId);
  if (!chunks || chunks.length === 0) return;
  const merged = Buffer.concat(chunks);
  const c = activeTerminals.get(terminalId);
  if (c) c.emitter.emit('output', merged.toString('base64'));
}

function emitOutput(terminalId, data) {
  const conn = activeTerminals.get(terminalId);
  if (!conn) return;

  let buf = outputBuffers.get(terminalId);
  if (!buf) { buf = []; outputBuffers.set(terminalId, buf); }
  buf.push(data);

  if (!outputTimers.has(terminalId)) {
    outputTimers.set(terminalId, setTimeout(() => {
      outputTimers.delete(terminalId);
      const chunks = outputBuffers.get(terminalId);
      outputBuffers.delete(terminalId);
      if (!chunks || chunks.length === 0) return;
      const merged = Buffer.concat(chunks);
      const c = activeTerminals.get(terminalId);
      if (c) c.emitter.emit('output', merged.toString('base64'));
    }, 10));
  }
}

// Serialize ttyd spawns to avoid tmux server lock contention.
// When multiple terminals are created back-to-back, concurrent ttyd processes
// each call `${TMUX} attach-session`, which contends for tmux's internal lock.
// This queue ensures only one ttyd spawn runs at a time.
let spawnQueue = Promise.resolve();

// Clean up stale ttyd processes on our port range at startup
try {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    try {
      if (process.platform === 'darwin') {
        // macOS: lsof returns PIDs directly, may return multiple lines
        const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim();
        if (output) {
          for (const line of output.split('\n')) {
            const pid = parseInt(line.trim());
            if (pid) process.kill(pid, 9);
          }
        }
      } else {
        // Linux: use ss
        const pid = execSync(`ss -tlnp | grep ":${port} " | grep -o 'pid=[0-9]*' | cut -d= -f2`, { encoding: 'utf-8' }).trim();
        if (pid) {
          process.kill(parseInt(pid), 9);
        }
      }
    } catch { /* port not in use */ }
  }
} catch {
  // Ignore errors
}

/**
 * True while a ttyd socket can still carry traffic. CONNECTING counts: the
 * attach path awaits the open handshake, so a socket mid-handshake is a
 * pending attachment rather than a dead one.
 */
function isSocketUsable(ws) {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

/**
 * Drop an attachment: silence its listeners, close its socket, and forget it.
 *
 * Removing the listeners is the part that matters. A closed socket stops
 * delivering, but one that is merely superseded keeps its 'message' handler
 * alive and keeps writing into the same terminal's emitter — which is how a
 * terminal ends up echoing each keystroke once per stale attachment.
 */
function discardAttachment(terminalId, attachment) {
  if (!attachment) return;
  const { ttydWs } = attachment;
  if (ttydWs) {
    try { ttydWs.removeAllListeners(); } catch { /* already gone */ }
    try {
      if (ttydWs.readyState === WebSocket.OPEN || ttydWs.readyState === WebSocket.CONNECTING) {
        ttydWs.close();
      }
    } catch { /* already closing */ }
  }
  if (activeTerminals.get(terminalId) === attachment) {
    activeTerminals.delete(terminalId);
  }
}

function getAvailablePort() {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports for ttyd');
}

function releasePort(port) {
  usedPorts.delete(port);
}

async function startTtyd(tmuxSession) {
  const existing = ttydProcesses.get(tmuxSession);
  if (existing) {
    return existing.port;
  }

  const port = getAvailablePort();

  return new Promise((resolve, reject) => {
    const ttyd = spawn('ttyd', [
      '-p', String(port),
      '-W',
      'tmux', ...TMUX_ARGS, 'attach-session', '-t', tmuxSession,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ttyd.stderr?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Listening on')) {
        ttydProcesses.set(tmuxSession, { process: ttyd, port });
        resolve(port);
      }
    });

    ttyd.on('error', (err) => {
      console.error(`[ttyd:${tmuxSession}] Error:`, err);
      releasePort(port);
      reject(err);
    });

    ttyd.on('exit', () => {
      const info = ttydProcesses.get(tmuxSession);
      if (info) {
        releasePort(info.port);
      }
      ttydProcesses.delete(tmuxSession);
    });

    setTimeout(() => {
      if (!ttydProcesses.has(tmuxSession)) {
        ttyd.kill();
        releasePort(port);
        reject(new Error('ttyd startup timeout'));
      }
    }, 5000);
  });
}

function startTtydSerialized(tmuxSession) {
  const task = spawnQueue.then(() => startTtyd(tmuxSession));
  // Update queue — swallow errors so a failed spawn doesn't block future spawns
  spawnQueue = task.catch(() => {});
  return task;
}

function stopTtyd(tmuxSession) {
  const info = ttydProcesses.get(tmuxSession);
  if (info) {
    info.process.kill();
    releasePort(info.port);
    ttydProcesses.delete(tmuxSession);
  }
}

function stopAllTtyd() {
  for (const [session] of ttydProcesses) {
    stopTtyd(session);
  }
}

/**
 * Connect to a ttyd WebSocket with retry logic
 */
function connectToTtyd(port, cols, rows, attempt = 1) {
  return new Promise((resolve, reject) => {
    const ttydUrl = `ws://localhost:${port}/ws`;
    const ttydWs = new WebSocket(ttydUrl, ['tty']);
    ttydWs.binaryType = 'arraybuffer';

    const timeout = setTimeout(() => {
      ttydWs.close();
      if (attempt < 5) {
        connectToTtyd(port, cols, rows, attempt + 1).then(resolve).catch(reject);
      } else {
        reject(new Error('Failed to connect to ttyd'));
      }
    }, 1000);

    ttydWs.on('open', () => {
      clearTimeout(timeout);
      ttydWs.send(JSON.stringify({ columns: cols || 80, rows: rows || 24 }));
      resolve(ttydWs);
    });

    ttydWs.on('error', (err) => {
      clearTimeout(timeout);
      if (attempt < 5) {
        setTimeout(() => {
          connectToTtyd(port, cols, rows, attempt + 1).then(resolve).catch(reject);
        }, 200);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Exported terminal manager — wraps ttyd spawn/proxy and terminal lifecycle.
 * Returns EventEmitters for each attached terminal that emit 'output' and 'closed'.
 */
export const terminalManager = {
  /**
   * Attach to a terminal. Spawns ttyd if needed and proxies data.
   * Returns an EventEmitter that emits:
   *   'output' (base64Data) — terminal output
   *   'closed' () — terminal connection closed
   *   'error' (message) — error occurred
   */
  async attachTerminal(terminalId, cols, rows) {
    // Reuse the existing attachment only while its socket is actually usable.
    // A cached entry whose ttyd connection has died (agent restart, ttyd
    // killed, network drop) would otherwise be handed back forever, and the
    // terminal would look attached while receiving nothing.
    const existing = activeTerminals.get(terminalId);
    if (existing) {
      if (isSocketUsable(existing.ttydWs)) {
        return existing.emitter;
      }
      // Dead socket: tear it down before attaching again, so its listeners
      // stop forwarding and we do not end up with two sockets feeding the
      // same terminal (which duplicates every keystroke and every byte of
      // output the terminal produces).
      discardAttachment(terminalId, existing);
    }

    // If another attachTerminal call is already in-flight for this id,
    // wait for it to finish and return its result instead of racing.
    const pending = pendingAttaches.get(terminalId);
    if (pending) {
      return pending;
    }

    const promise = this._doAttach(terminalId, cols, rows);
    pendingAttaches.set(terminalId, promise);
    try {
      return await promise;
    } finally {
      pendingAttaches.delete(terminalId);
    }
  },

  async _doAttach(terminalId, cols, rows) {
    const terminal = tmuxService.getTerminal(terminalId);
    if (!terminal) {
      console.warn(`[TerminalManager] Terminal ${terminalId.slice(0,8)} not found, skipping attach`);
      const emitter = new EventEmitter();
      // Use setTimeout so the caller's await chain resolves and wires the
      // error handler before the event fires. nextTick fires before Promise
      // microtasks in Node.js, causing an unhandled error crash.
      setTimeout(() => emitter.emit('error', 'Terminal not found'), 0);
      return emitter;
    }

    const emitter = new EventEmitter();

    try {
      const port = await startTtydSerialized(terminal.tmuxSession);
      let ttydWs;

      try {
        ttydWs = await connectToTtyd(port, cols, rows);
      } catch (err) {
        // If ttyd exists but connection failed, restart it and retry once
        if (ttydProcesses.has(terminal.tmuxSession)) {
          stopTtyd(terminal.tmuxSession);
          const retryPort = await startTtydSerialized(terminal.tmuxSession);
          ttydWs = await connectToTtyd(retryPort, cols, rows);
        } else {
          throw err;
        }
      }

      // Another attachment may have been registered while we were connecting.
      // Replacing it without closing it would leave its listeners forwarding
      // the same terminal, so every keystroke and every byte of output would
      // arrive twice.
      const superseded = activeTerminals.get(terminalId);
      if (superseded && superseded.ttydWs !== ttydWs) {
        discardAttachment(terminalId, superseded);
      }

      activeTerminals.set(terminalId, { ttydWs, emitter });
      console.log(`[TerminalManager] ttyd WS connected for ${terminalId.slice(0,8)} on port ${port}, readyState=${ttydWs.readyState}`);

      ttydWs.on('ping', () => {
        console.log(`[TerminalManager] ttyd ping for ${terminalId.slice(0,8)} at ${Date.now()} buffered=${ttydWs.bufferedAmount} readyState=${ttydWs.readyState}`);
      });

      ttydWs.on('message', (data) => {
        const buffer = Buffer.from(data);
        const msgType = String.fromCharCode(buffer[0]);
        if (msgType === '0') {
          emitOutput(terminalId, buffer.slice(1));
        }
      });

      ttydWs.on('close', (code, reason) => {
        console.warn(`[TerminalManager] ttyd WS closed for ${terminalId.slice(0,8)}: code=${code} reason=${reason || ''}`);
        // Only delete if this WS is still the current one for this terminal.
        // Prevents a stale connection's close from nuking a newer connection.
        const current = activeTerminals.get(terminalId);
        if (current && current.ttydWs === ttydWs) {
          flushOutput(terminalId);
          activeTerminals.delete(terminalId);
          emitter.emit('closed');
        } else {
          console.warn(`[TerminalManager] ttyd WS close ignored for ${terminalId.slice(0,8)} (stale connection)`);
        }
      });

      ttydWs.on('error', (error) => {
        console.error(`[TerminalManager] ttyd error for ${terminalId.slice(0,8)}:`, error.message);
        emitter.emit('error', 'Terminal connection error');
      });

      // Signal successful attachment (nextTick so listener can be registered first)
      process.nextTick(() => emitter.emit('attached', { terminalId, cols, rows }));

    } catch (error) {
      console.error(`[TerminalManager] Failed to attach ${terminalId}:`, error.message);
      process.nextTick(() => emitter.emit('error', 'Failed to start terminal'));
    }

    return emitter;
  },

  /**
   * Send input data to a terminal
   */
  sendInput(terminalId, base64Data) {
    const conn = activeTerminals.get(terminalId);
    if (!conn || !conn.ttydWs || conn.ttydWs.readyState !== WebSocket.OPEN) {
      console.warn(`[TerminalManager] sendInput dropped for ${terminalId.slice(0,8)}: conn=${!!conn} ws=${conn?.ttydWs ? conn.ttydWs.readyState : 'none'}`);
      return;
    }

    const inputData = Buffer.from(base64Data, 'base64');
    const msg = Buffer.alloc(inputData.length + 1);
    msg[0] = 0x30; // '0' — ttyd input prefix
    inputData.copy(msg, 1);
    conn.ttydWs.send(msg);
  },

  /**
   * Resize a terminal
   */
  resizeTerminal(terminalId, cols, rows, pixelWidth, pixelHeight) {
    const conn = activeTerminals.get(terminalId);
    if (conn && conn.ttydWs && conn.ttydWs.readyState === WebSocket.OPEN) {
      const resizeData = JSON.stringify({ columns: cols, rows });
      const msg = Buffer.alloc(1 + resizeData.length);
      msg[0] = 0x31; // '1' — ttyd resize prefix
      msg.write(resizeData, 1);
      conn.ttydWs.send(msg);
    }

    // Also resize the tmux pane (and persist pixel size if provided)
    tmuxService.resizeTerminal(terminalId, cols, rows, pixelWidth, pixelHeight);
  },

  /**
   * Scroll a terminal via tmux copy-mode
   */
  scrollTerminal(terminalId, lines) {
    tmuxService.scrollTerminal(terminalId, lines);
  },

  /**
   * Close a terminal (kill tmux session + stop ttyd)
   */
  async closeTerminal(terminalId) {
    const terminal = tmuxService.getTerminal(terminalId);

    // Close ttyd connection
    const conn = activeTerminals.get(terminalId);
    if (conn && conn.ttydWs) {
      flushOutput(terminalId);
      discardAttachment(terminalId, conn);
    }

    if (terminal) {
      stopTtyd(terminal.tmuxSession);
      await tmuxService.closeTerminal(terminalId);
    }
  },

  /**
   * Detach from a terminal (close ttyd WS but keep tmux session alive)
   */
  detachTerminal(terminalId) {
    const conn = activeTerminals.get(terminalId);
    if (conn && conn.ttydWs) {
      flushOutput(terminalId);
      discardAttachment(terminalId, conn);
    }
  },

  /**
   * List active terminal connections
   */
  listTerminals() {
    const list = [];
    for (const [terminalId, conn] of activeTerminals) {
      const terminal = tmuxService.getTerminal(terminalId);
      list.push({
        id: terminalId,
        tmuxSession: terminal?.tmuxSession,
        connected: conn.ttydWs?.readyState === WebSocket.OPEN,
      });
    }
    return list;
  },

  /**
   * Stop all ttyd processes (for shutdown)
   */
  stopAll() {
    // Close all active connections
    for (const [terminalId, conn] of activeTerminals) {
      if (conn.ttydWs) {
        conn.ttydWs.close();
      }
    }
    activeTerminals.clear();
    stopAllTtyd();
  },
};
