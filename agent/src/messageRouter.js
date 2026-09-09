import { MSG } from './protocol.js';
import { terminalManager } from './terminalManager.js';
import { tmuxService } from '../services/tmux.js';
import { filePaneService } from '../services/filePanes.js';
import { noteService } from '../services/notes.js';
import { gitGraphService } from '../services/gitGraph.js';
import { iframeService } from '../services/iframes.js';
import { beadsService } from '../services/beads.js';
import { conversationsService } from '../services/conversations.js';
import { folderPaneService } from '../services/folderPanes.js';
import { getLocalMetrics } from '../services/metrics.js';
import { performUpdate } from './updater.js';
import { validateWorkingDirectory } from '../services/sanitize.js';
import { beginUpload, appendChunk, commitUpload, abortUpload, CHUNK_SIZE, MAX_UPLOAD_BYTES } from '../services/uploads.js';
import { readTextFileForTransport } from '../services/fileRead.js';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, rmdirSync, mkdirSync } from 'fs';

const execAsync = promisify(exec);
import { join, basename, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';

// Get local hostname
let localHostname = 'localhost';
try {
  localHostname = execSync('hostname', { encoding: 'utf-8' }).trim();
} catch {}

/**
 * Get OAuth access token from env var, credentials file, or macOS Keychain.
 * Returns the token string or null if unavailable.
 */
async function getOAuthToken() {
  // 1. Environment variable (works everywhere, set by Claude Desktop or manually)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // 2. Credentials file (Linux/Windows)
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const token = creds.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {}

  // 3. macOS Keychain fallback
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { timeout: 5000 }
      );
      const keychainData = JSON.parse(stdout.trim());
      const token = keychainData.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch {}
  }

  return null;
}

function expandHome(p) {
  if (p === '~' || p === '~/') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Expand ~ and validate that the resolved path is within allowed directories.
 * Prevents path traversal attacks on file operation endpoints.
 */
function expandAndValidatePath(p) {
  const expanded = expandHome(p);
  const resolved = resolve(expanded);
  validateWorkingDirectory(resolved);
  return resolved;
}

/**
 * Create a message router that dispatches incoming relay messages
 * to local services and sends responses back through the relay.
 *
 * @param {Function} sendToRelay - function(type, payload) to send messages back to cloud
 * @param {Object} [options] - optional callbacks
 * @returns {Function} handler - function(message) to handle incoming messages
 */
export function createMessageRouter(sendToRelay, options = {}) {

  // Usage API cache (5-minute TTL to avoid rate limiting)
  const USAGE_CACHE_TTL = 5 * 60 * 1000;
  let usageCache = null;
  let usageCacheTime = 0;

  // Terminal message handlers
  // Track which terminals we've already wired up relay listeners for
  const wiredTerminals = new Set();

  // Buffer live output while history capture is in-flight.
  // Without this, ttyd output reaches the browser before terminal:history,
  // causing garbled/out-of-order content on page load.
  const pendingHistoryCapture = new Map(); // terminalId -> base64Data[]

  // Capture tmux history, send it, then flush any buffered output.
  async function captureHistoryAndFlush(terminalId, cols, rows) {
    pendingHistoryCapture.set(terminalId, []);
    try {
      // Resize tmux pane to match browser BEFORE capturing. ttyd sends the
      // resize via pty ioctl which races with our capture — by calling
      // tmux resize-pane directly we guarantee the correct width.
      await tmuxService.resizeTerminal(terminalId, cols, rows);
    } catch {}
    try {
      const history = await tmuxService.captureHistory(terminalId);
      if (history) {
        // Strip tmux-injected cursor/screen control sequences that aren't part
        // of the original pty stream. capture-pane -e adds these to mark the
        // visible area boundary; replaying them in xterm.js moves the cursor to
        // unexpected positions and leaves stale '_' glyphs at line starts.
        // Specifically strip: cursor position (\e[H, \e[row;colH), cursor
        // show/hide (\e[?25h/l), erase display (\e[J, \e[2J), and tmux's
        // own OSC/DCS sequences that bleed through with -e.
        const stripped = history
          .replace(/\x1b\[\d*;\d*H/g, '')   // \e[row;colH  cursor position
          .replace(/\x1b\[\d*H/g, '')        // \e[H / \e[nH cursor position
          .replace(/\x1b\[\?25[hl]/g, '')    // \e[?25h/l    cursor show/hide
          .replace(/\x1b\[[\d;]*J/g, '')     // \e[J/2J      erase display
          .replace(/\x1bP[^\x1b]*\x1b\\/g, '') // DCS sequences
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // OSC sequences
        // Only convert bare \n (not already \r\n) to \r\n for xterm.
        const normalized = stripped.replace(/(?<!\r)\n/g, '\r\n');
        const base64History = Buffer.from(normalized).toString('base64');
        sendToRelay(MSG.TERMINAL_HISTORY, { terminalId, data: base64History });
      }
    } catch (err) {
      console.error(`[Terminal] Failed to capture history for ${terminalId.slice(0,8)}:`, err.message);
    }
    // Flush buffered output that arrived during capture
    const buffered = pendingHistoryCapture.get(terminalId);
    pendingHistoryCapture.delete(terminalId);
    if (buffered) {
      for (const data of buffered) {
        sendToRelay(MSG.TERMINAL_OUTPUT, { terminalId, data });
      }
    }
    sendToRelay(MSG.TERMINAL_ATTACHED, { terminalId, cols, rows });
  }

  const terminalHandlers = {
    [MSG.TERMINAL_ATTACH]: async (payload) => {
      const { terminalId, cols, rows } = payload;
      const alreadyWired = wiredTerminals.has(terminalId);
      const emitter = await terminalManager.attachTerminal(terminalId, cols, rows);

      if (!alreadyWired) {
        wiredTerminals.add(terminalId);

        // Wire error handler once to prevent crash on ttyd failures.
        // Also unwires on error, same as the 'closed' handler below: an
        // errored attachment's emitter is done, and attachTerminal() hands
        // back a brand-new EventEmitter on the next attach attempt. Leaving
        // this terminalId marked "wired" would skip listening on that new
        // emitter entirely, so its next error would have zero listeners —
        // and an EventEmitter throws on an unhandled 'error' event, killing
        // the whole agent process.
        emitter.on('error', (message) => {
          console.error(`[Terminal] Error for ${terminalId.slice(0,8)}:`, message);
          wiredTerminals.delete(terminalId);
          sendToRelay(MSG.TERMINAL_ERROR, { terminalId, message });
        });

        emitter.on('output', (base64Data) => {
          // Buffer output while history capture is in-flight
          const pending = pendingHistoryCapture.get(terminalId);
          if (pending) {
            pending.push(base64Data);
            return;
          }
          sendToRelay(MSG.TERMINAL_OUTPUT, { terminalId, data: base64Data });
        });

        emitter.on('closed', () => {
          wiredTerminals.delete(terminalId);
          pendingHistoryCapture.delete(terminalId);
          sendToRelay(MSG.TERMINAL_CLOSED, { terminalId });
        });

        // Capture history directly instead of relying on the 'attached' event.
        // terminalManager emits 'attached' via process.nextTick, which fires
        // BEFORE promise microtasks in Node.js — so the handler wired above
        // would never catch it (the event fires before this code runs).
        await captureHistoryAndFlush(terminalId, cols, rows);
      } else {
        // Already attached — buffer output during history recapture
        await captureHistoryAndFlush(terminalId, cols, rows);
      }
      // Force tmux to resend screen content by nudging the pane size.
      // Without this, terminals reconnected after relay drops (or resumed
      // after being killed) may show stale/blank visible area.
      setTimeout(() => {
        tmuxService.forceRedraw(terminalId, cols, rows).catch(() => {});
      }, 200);
    },

    [MSG.TERMINAL_INPUT]: (payload) => {
      terminalManager.sendInput(payload.terminalId, payload.data);
    },

    // Dropped/pasted images arrive as base64 over the WS channel (browser
    // paste/drop events can't carry real image bytes through xterm's
    // bracketed-paste text-only path). Write to a temp file and inject its
    // path wrapped in a bracketed-paste block (ESC[200~ ... ESC[201~) —
    // Claude Code's readline only runs its "is this a pasted image path"
    // check on bracketed-paste content, not on plain typed keystrokes,
    // which is why a real OS-level drag-drop (which also arrives as a
    // bracketed paste) triggers the [Image #N] attachment and bare typed
    // text doesn't.
    [MSG.TERMINAL_PASTE_IMAGE]: (payload) => {
      const EXT_BY_MIME = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      };
      const ext = EXT_BY_MIME[payload.mimeType];
      if (!ext) return;

      const filePath = join(tmpdir(), `49agents-paste-${randomBytes(6).toString('hex')}.${ext}`);
      try {
        writeFileSync(filePath, Buffer.from(payload.imageData, 'base64'));
      } catch (error) {
        console.error('[messageRouter] Failed to write pasted image:', error.message);
        return;
      }

      const bracketed = `\x1b[200~${filePath}\x1b[201~`;
      const encoded = Buffer.from(bracketed, 'utf-8').toString('base64');
      terminalManager.sendInput(payload.terminalId, encoded);
    },

    [MSG.TERMINAL_RESIZE]: (payload) => {
      terminalManager.resizeTerminal(payload.terminalId, payload.cols, payload.rows, payload.pixelWidth, payload.pixelHeight);
    },

    [MSG.TERMINAL_SCROLL]: (payload) => {
      terminalManager.scrollTerminal(payload.terminalId, payload.lines);
    },

    [MSG.TERMINAL_CLOSE]: async (payload) => {
      wiredTerminals.delete(payload.terminalId);
      await terminalManager.closeTerminal(payload.terminalId);
      sendToRelay(MSG.TERMINAL_CLOSED, { terminalId: payload.terminalId });
    },

    [MSG.TERMINAL_DETACH]: (payload) => {
      wiredTerminals.delete(payload.terminalId);
      terminalManager.detachTerminal(payload.terminalId);
      sendToRelay('terminal:detached', { terminalId: payload.terminalId });
    },
  };

  /**
   * Handle REST-over-WS requests: dispatches by method + path to service functions.
   * Request format: { type: 'request', id: '<uuid>', payload: { method, path, body } }
   * Response format: { type: 'response', id: '<uuid>', payload: { status, body } }
   */
  async function handleRequest(message) {
    const { id, payload } = message;
    const { method, body = {} } = payload;

    // Parse query params from path (frontend embeds them in the URL)
    let path = payload.path;
    let query = {};
    const qIdx = path.indexOf('?');
    if (qIdx !== -1) {
      const qs = path.slice(qIdx + 1);
      path = path.slice(0, qIdx);
      for (const pair of qs.split('&')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx !== -1) {
          query[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
        }
      }
    }

    const respond = (status, responseBody) => {
      sendToRelay(MSG.RESPONSE, { status, body: responseBody }, { id });
    };

    try {
      // Route based on method + path
      const route = `${method} ${path}`;

      switch (route) {
        // === Terminals ===
        case 'GET /api/terminals': {
          const terminals = await tmuxService.listTerminals();
          return respond(200, terminals);
        }
        case 'POST /api/terminals': {
          const { workingDir = '~', position, device, size } = body;
          const terminal = await tmuxService.createTerminal(workingDir, position, device, size);
          return respond(200, terminal);
        }
        case 'POST /api/terminals/resume': {
          const { terminalId, workingDir = '~', command = null } = body;
          if (!terminalId) return respond(400, { error: 'terminalId required' });
          const terminal = await tmuxService.resumeTerminal(terminalId, workingDir, command);
          return respond(200, terminal);
        }
        case 'GET /api/terminals/processes': {
          const processes = await tmuxService.getAllProcessInfo();
          return respond(200, processes);
        }
        case 'GET /api/terminals/states': {
          const states = await tmuxService.getAllClaudeStates();
          return respond(200, states);
        }

        // === File browsing ===
        case 'GET /api/files/browse': {
          const dirPath = query.path || '~';
          const resolvedPath = expandAndValidatePath(dirPath);
          const items = readdirSync(resolvedPath);
          let entries = [];
          for (const name of items) {
            if (!query.showHidden && name.startsWith('.')) continue;
            try {
              const fullPath = join(resolvedPath, name);
              const stat = statSync(fullPath);
              entries.push({
                name,
                type: stat.isDirectory() ? 'dir' : 'file',
                size: stat.size,
              });
            } catch { /* skip files we can't stat */ }
          }
          entries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return respond(200, { path: resolvedPath, entries });
        }
        case 'GET /api/files/read': {
          const filePath = query.path;
          if (!filePath) {
            return respond(400, { error: 'path parameter required' });
          }
          const resolvedPath = expandAndValidatePath(filePath);
          let content;
          try {
            content = readTextFileForTransport(resolvedPath);
          } catch (e) {
            // A response over the relay cap does not fail the request, it
            // closes the agent's own socket. Declining with a message keeps the
            // agent online.
            if (e.code === 'EFBIG') return respond(413, { error: e.message, code: 'EFBIG' });
            throw e;
          }
          const fileName = resolvedPath.split('/').pop() || basename(resolvedPath);
          return respond(200, { content, fileName, filePath: resolvedPath, device: localHostname });
        }
        case 'POST /api/files/create': {
          const { path: filePath } = body;
          if (!filePath) {
            return respond(400, { error: 'path parameter required' });
          }
          const resolvedPath = expandAndValidatePath(filePath);
          writeFileSync(resolvedPath, '', 'utf-8');
          const fileName = basename(filePath);
          return respond(200, { fileName, filePath, device: localHostname });
        }
        case 'DELETE /api/files/delete': {
          const { path: filePath } = body;
          if (!filePath) return respond(400, { error: 'path parameter required' });
          const resolvedPath = expandAndValidatePath(filePath);
          const stat = statSync(resolvedPath);
          if (stat.isDirectory()) {
            rmdirSync(resolvedPath);
          } else {
            unlinkSync(resolvedPath);
          }
          return respond(200, { success: true });
        }
        case 'POST /api/files/rename': {
          const { oldPath, newPath } = body;
          if (!oldPath || !newPath) return respond(400, { error: 'oldPath and newPath required' });
          const resolvedOld = expandAndValidatePath(oldPath);
          const resolvedNew = expandAndValidatePath(newPath);
          renameSync(resolvedOld, resolvedNew);
          return respond(200, { success: true, newPath: resolvedNew });
        }
        // === File upload ===
        // Chunked because it has to be: the relay caps a message at 1MB and
        // chunks arrive base64-encoded, so a whole file in one request would
        // top out well under that. See services/uploads.js.
        case 'GET /api/files/upload/limits': {
          return respond(200, { chunkSize: CHUNK_SIZE, maxBytes: MAX_UPLOAD_BYTES });
        }
        case 'POST /api/files/upload/begin': {
          try {
            return respond(200, beginUpload(body));
          } catch (e) {
            // A collision is an answerable question for the user, not a
            // failure, so it gets its own status rather than a generic 400.
            if (e.code === 'EEXIST') return respond(409, { error: e.message, code: 'EEXIST' });
            return respond(400, { error: e.message });
          }
        }
        case 'POST /api/files/upload/chunk': {
          try {
            return respond(200, appendChunk(body));
          } catch (e) {
            return respond(400, { error: e.message });
          }
        }
        case 'POST /api/files/upload/commit': {
          try {
            return respond(200, await commitUpload(body));
          } catch (e) {
            return respond(400, { error: e.message });
          }
        }
        case 'POST /api/files/upload/abort': {
          return respond(200, abortUpload(body?.id));
        }
        case 'POST /api/files/mkdir': {
          const { path: dirPath } = body;
          if (!dirPath) return respond(400, { error: 'path parameter required' });
          const resolvedPath = expandAndValidatePath(dirPath);
          mkdirSync(resolvedPath, { recursive: true });
          return respond(200, { success: true, path: resolvedPath });
        }

        // === File Panes ===
        case 'GET /api/file-panes': {
          const filePanes = filePaneService.listFilePanes();
          return respond(200, filePanes);
        }
        case 'POST /api/file-panes': {
          const { fileName, filePath, content, position, device, size } = body;
          const filePane = filePaneService.createFilePane({ fileName, filePath, content, position, device, size });
          return respond(200, filePane);
        }

        // === Notes ===
        case 'GET /api/notes': {
          const notes = noteService.listNotes();
          return respond(200, notes);
        }
        case 'POST /api/notes': {
          const { position, size } = body;
          const note = noteService.createNote({ position, size });
          return respond(200, note);
        }

        // === Git Graphs ===
        case 'GET /api/git-repos': {
          const onFound = (repo) => sendToRelay(MSG.SCAN_PARTIAL, { repos: [repo] }, { id });
          const repos = await gitGraphService.scanForRepos(onFound);
          return respond(200, repos);
        }
        case 'GET /api/git-repos/in-folder': {
          const folderPath = query.path;
          if (!folderPath) {
            return respond(400, { error: 'path query param required' });
          }
          const onFound = (repo) => sendToRelay(MSG.SCAN_PARTIAL, { repos: [repo] }, { id });
          const repos = await gitGraphService.scanReposInFolder(folderPath, onFound);
          return respond(200, repos);
        }
        case 'GET /api/git-graphs': {
          const gitGraphs = gitGraphService.listGitGraphs();
          return respond(200, gitGraphs);
        }
        case 'POST /api/git-graphs': {
          const { repoPath, position, device, size } = body;
          if (!repoPath) {
            return respond(400, { error: 'repoPath is required' });
          }
          expandAndValidatePath(repoPath);
          const gitGraph = gitGraphService.createGitGraph({ repoPath, position, device, size });
          return respond(200, gitGraph);
        }

        // === Iframes ===
        case 'GET /api/iframes': {
          const iframes = iframeService.listIframes();
          return respond(200, iframes);
        }
        case 'POST /api/iframes': {
          const { url, position, size } = body;
          const iframe = iframeService.createIframe({ url, position, size });
          return respond(200, iframe);
        }

        // === Beads ===
        case 'GET /api/beads-projects/in-folder': {
          const rawPath = query.path;
          if (!rawPath) return respond(400, { error: 'path query param required' });
          const folderPath = expandHome(rawPath);
          const onFound = (repo) => {
            if (existsSync(join(repo.path, '.beads'))) {
              sendToRelay(MSG.SCAN_PARTIAL, { repos: [repo] }, { id });
            }
          };
          const repos = await gitGraphService.scanReposInFolder(folderPath, onFound);
          const subRepos = repos.filter(r => r.path !== folderPath);
          const candidates = [{ path: folderPath, name: folderPath.split('/').pop() }, ...subRepos];
          const beadsProjects = candidates.filter(r => existsSync(join(r.path, '.beads')));
          return respond(200, beadsProjects);
        }
        case 'GET /api/beads-panes': {
          const beadsPanes = beadsService.listBeadsPanes();
          return respond(200, beadsPanes);
        }
        case 'POST /api/beads-panes': {
          const { projectPath, position, size, device } = body;
          const beadsPane = beadsService.createBeadsPane({ projectPath, position, size, device });
          return respond(200, beadsPane);
        }

        // === Conversations Panes ===
        case 'GET /api/conversations-panes': {
          const convosPanes = conversationsService.listConversationsPanes();
          return respond(200, convosPanes);
        }
        case 'POST /api/conversations-panes': {
          const { dirPath, position, size, device } = body;
          const convosPane = conversationsService.createConversationsPane({ dirPath, position, size, device });
          return respond(200, convosPane);
        }

        // === Folder Panes ===
        case 'GET /api/folder-panes': {
          const folderPanes = folderPaneService.listFolderPanes();
          return respond(200, folderPanes);
        }
        case 'POST /api/folder-panes': {
          const { folderPath, position, size } = body;
          const folderPane = folderPaneService.createFolderPane({ folderPath, position, size });
          return respond(200, folderPane);
        }

        // === Git Status (lightweight, for folder pane — async) ===
        case 'GET /api/git-status': {
          const gsPath = expandHome(query.path || '~');
          const gsOpts = { cwd: gsPath, encoding: 'utf-8', timeout: 10000 };
          try {
            await execAsync('git rev-parse --is-inside-work-tree', gsOpts);
            const [gsRootResult, gsBranchResult, porcelainResult] = await Promise.all([
              execAsync('git rev-parse --show-toplevel', gsOpts),
              execAsync('git branch --show-current', gsOpts),
              execAsync('git status --porcelain', gsOpts),
            ]);
            const gsRoot = gsRootResult.stdout.trim();
            const gsBranch = gsBranchResult.stdout.trim() || 'HEAD';
            const porcelainRaw = porcelainResult.stdout;
            const files = {};
            let staged = 0, unstaged = 0, untracked = 0;
            for (const line of porcelainRaw.split('\n').filter(l => l.length >= 4)) {
              const x = line[0], y = line[1];
              const filePath = line.slice(3).split(' -> ').pop();
              const absPath = gsRoot + '/' + filePath;
              let status = 'modified';
              if (x === '?' && y === '?') { status = 'untracked'; untracked++; }
              else if (x === 'A' || y === 'A') { status = 'added'; if (x !== ' ') staged++; if (y !== ' ' && y !== '?') unstaged++; }
              else if (x === 'D' || y === 'D') { status = 'deleted'; if (x !== ' ') staged++; if (y !== ' ' && y !== '?') unstaged++; }
              else if (x === 'R') { status = 'renamed'; staged++; if (y !== ' ') unstaged++; }
              else { if (x !== ' ') staged++; if (y !== ' ' && y !== '?') unstaged++; }
              files[absPath] = status;
            }
            const gsTotal = staged + unstaged + untracked;
            return respond(200, { isGit: true, branch: gsBranch, clean: gsTotal === 0, uncommitted: { total: gsTotal, staged, unstaged, untracked }, files });
          } catch {
            return respond(200, { isGit: false });
          }
        }

        // === Usage (proxy to Anthropic API with caching) ===
        case 'GET /api/usage': {
          const now = Date.now();
          const force = query.force === 'true';
          if (!force && usageCache && (now - usageCacheTime) < USAGE_CACHE_TTL) {
            return respond(200, usageCache);
          }
          try {
            const token = await getOAuthToken();
            if (!token) {
              console.warn('[usage] No OAuth token found (env, credentials file, or macOS Keychain)');
              return respond(503, { error: 'Claude credentials not available' });
            }

            const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
              headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': 'oauth-2025-04-20'
              }
            });
            if (!resp.ok) {
              const text = await resp.text();
              console.warn(`[usage] Anthropic API returned ${resp.status}:`, text.slice(0, 200));
              // On rate limit, serve stale cache if available rather than failing
              if (resp.status === 429 && usageCache) {
                return respond(200, { ...usageCache, stale: true });
              }
              return respond(resp.status, { error: text });
            }
            const data = await resp.json();
            usageCache = data;
            usageCacheTime = now;
            return respond(200, data);
          } catch (err) {
            console.warn('[usage] Failed to fetch usage data:', err.message);
            return respond(500, { error: err.message || 'Failed to fetch usage data' });
          }
        }

        // === Metrics ===
        case 'GET /api/metrics': {
          const metrics = await getLocalMetrics();
          return respond(200, [{ name: localHostname, ip: '127.0.0.1', os: process.platform, online: true, isLocal: true, metrics }]);
        }

        // === Devices (local only for agent) ===
        case 'GET /api/devices': {
          return respond(200, [{
            name: localHostname,
            ip: '127.0.0.1',
            os: process.platform,
            online: true,
            isLocal: true,
          }]);
        }

        default:
          break;
      }

      // Handle parameterized routes (with :id)
      // Terminal routes: DELETE /api/terminals/:id
      const terminalMatch = path.match(/^\/api\/terminals\/([^/]+)$/);
      if (terminalMatch) {
        const id = terminalMatch[1];
        if (method === 'DELETE') {
          await tmuxService.closeTerminal(id);
          return respond(200, { success: true });
        }
      }

      // File pane routes: GET/PATCH/DELETE /api/file-panes/:id
      const filePaneMatch = path.match(/^\/api\/file-panes\/([^/]+)$/);
      if (filePaneMatch) {
        const id = filePaneMatch[1];
        if (method === 'GET') {
          const refresh = query.refresh === 'true';
          const filePane = filePaneService.getFilePane(id, refresh);
          if (!filePane) return respond(404, { error: 'File pane not found' });
          return respond(200, filePane);
        }
        if (method === 'PATCH') {
          const updates = {};
          // Position/size now handled by cloud-only storage
          if (body.content !== undefined) updates.content = body.content;
          filePaneService.updateFilePane(id, updates);
          return respond(200, { success: true });
        }
        if (method === 'DELETE') {
          filePaneService.deleteFilePane(id);
          return respond(200, { success: true });
        }
      }

      // Note routes: GET/PATCH/DELETE /api/notes/:id
      const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
      if (noteMatch) {
        const id = noteMatch[1];
        if (method === 'GET') {
          const note = noteService.getNote(id);
          if (!note) return respond(404, { error: 'Note not found' });
          return respond(200, note);
        }
        if (method === 'PATCH') {
          const updates = {};
          // Position/size now handled by cloud-only storage
          if (body.content !== undefined) updates.content = body.content;
          if (body.fontSize !== undefined) updates.fontSize = body.fontSize;
          noteService.updateNote(id, updates);
          return respond(200, { success: true });
        }
        if (method === 'DELETE') {
          noteService.deleteNote(id);
          return respond(200, { success: true });
        }
      }

      // Git graph routes: GET/PATCH/DELETE /api/git-graphs/:id, GET /api/git-graphs/:id/data, POST /api/git-graphs/:id/push
      const gitGraphDataMatch = path.match(/^\/api\/git-graphs\/([^/]+)\/data$/);
      if (gitGraphDataMatch && method === 'GET') {
        const id = gitGraphDataMatch[1];
        const gitGraph = gitGraphService.getGitGraph(id);
        if (!gitGraph) return respond(404, { error: 'Git graph pane not found' });
        const maxCommits = parseInt(query.maxCommits) || 50;
        const ascii = query.mode === 'ascii';
        const data = await gitGraphService.fetchGraphData(gitGraph.repoPath, maxCommits, { ascii });
        return respond(200, data);
      }

      const gitGraphPushMatch = path.match(/^\/api\/git-graphs\/([^/]+)\/push$/);
      if (gitGraphPushMatch && method === 'POST') {
        const id = gitGraphPushMatch[1];
        const gitGraph = gitGraphService.getGitGraph(id);
        if (!gitGraph) return respond(404, { error: 'Git graph pane not found' });
        expandAndValidatePath(gitGraph.repoPath);
        try {
          // Use -c overrides to neutralize malicious git config values
          const { stdout, stderr } = await execAsync(
            'git -c core.pager=cat -c core.sshCommand=ssh -c core.fsmonitor= -c core.hooksPath= push origin HEAD 2>&1',
            {
              cwd: gitGraph.repoPath,
              encoding: 'utf-8',
              timeout: 30000,
            }
          );
          return respond(200, { success: true, output: (stdout || stderr || '').trim() });
        } catch (error) {
          const stderr = error.stderr || error.stdout || error.message;
          return respond(500, { error: stderr.trim() });
        }
      }

      const gitGraphMatch = path.match(/^\/api\/git-graphs\/([^/]+)$/);
      if (gitGraphMatch) {
        const id = gitGraphMatch[1];
        if (method === 'PATCH') {
          const updates = {};
          // Position/size now handled by cloud-only storage
          if (body.repoPath !== undefined) {
            expandAndValidatePath(body.repoPath);
            updates.repoPath = body.repoPath;
          }
          gitGraphService.updateGitGraph(id, updates);
          return respond(200, { success: true });
        }
        if (method === 'DELETE') {
          gitGraphService.deleteGitGraph(id);
          return respond(200, { success: true });
        }
      }

      // Iframe routes: PATCH/DELETE /api/iframes/:id
      const iframeMatch = path.match(/^\/api\/iframes\/([^/]+)$/);
      if (iframeMatch) {
        const id = iframeMatch[1];
        if (method === 'PATCH') {
          const updates = {};
          // Position/size now handled by cloud-only storage
          if (body.url !== undefined) updates.url = body.url;
          const iframe = iframeService.updateIframe(id, updates);
          return respond(200, iframe);
        }
        if (method === 'DELETE') {
          iframeService.deleteIframe(id);
          return respond(200, { success: true });
        }
      }

      // Beads pane routes: GET /api/beads-panes/:id/data, PATCH/DELETE /api/beads-panes/:id
      const beadsDataMatch = path.match(/^\/api\/beads-panes\/([^/]+)\/data$/);
      if (beadsDataMatch && method === 'GET') {
        const id = beadsDataMatch[1];
        const beadsPane = beadsService.getBeadsPane(id);
        if (!beadsPane) return respond(404, { error: 'Beads pane not found' });
        const statusFilter = query.status || null;
        const data = await beadsService.fetchIssues(beadsPane.projectPath, statusFilter);
        return respond(200, data);
      }

      // POST /api/beads-panes/:id/issues/:issueId/close
      const beadsCloseMatch = path.match(/^\/api\/beads-panes\/([^/]+)\/issues\/([^/]+)\/close$/);
      if (beadsCloseMatch && method === 'POST') {
        const id = beadsCloseMatch[1];
        const issueId = beadsCloseMatch[2];
        const beadsPane = beadsService.getBeadsPane(id);
        if (!beadsPane) return respond(404, { error: 'Beads pane not found' });
        const result = await beadsService.closeIssue(beadsPane.projectPath, issueId);
        return respond(200, result);
      }

      // POST /api/beads-panes/:id/issues (create)
      const beadsCreateMatch = path.match(/^\/api\/beads-panes\/([^/]+)\/issues$/);
      if (beadsCreateMatch && method === 'POST') {
        const id = beadsCreateMatch[1];
        const beadsPane = beadsService.getBeadsPane(id);
        if (!beadsPane) return respond(404, { error: 'Beads pane not found' });
        const result = await beadsService.createIssue(beadsPane.projectPath, body);
        return respond(200, result);
      }

      // GET /api/beads-panes/:id/issues/:issueId
      const beadsIssueMatch = path.match(/^\/api\/beads-panes\/([^/]+)\/issues\/([^/]+)$/);
      if (beadsIssueMatch && method === 'GET') {
        const id = beadsIssueMatch[1];
        const issueId = beadsIssueMatch[2];
        const beadsPane = beadsService.getBeadsPane(id);
        if (!beadsPane) return respond(404, { error: 'Beads pane not found' });
        const issue = await beadsService.fetchIssue(beadsPane.projectPath, issueId);
        return respond(200, issue);
      }

      const beadsPaneMatch = path.match(/^\/api\/beads-panes\/([^/]+)$/);
      if (beadsPaneMatch) {
        const id = beadsPaneMatch[1];
        if (method === 'PATCH') {
          const updates = {};
          // Position/size now handled by cloud-only storage
          if (body.projectPath !== undefined) updates.projectPath = body.projectPath;
          beadsService.updateBeadsPane(id, updates);
          return respond(200, { success: true });
        }
        if (method === 'DELETE') {
          beadsService.deleteBeadsPane(id);
          return respond(200, { success: true });
        }
      }

      // Conversations pane routes: GET /api/conversations-panes/:id/data, PATCH/DELETE /api/conversations-panes/:id
      const convosDataMatch = path.match(/^\/api\/conversations-panes\/([^/]+)\/data$/);
      if (convosDataMatch && method === 'GET') {
        const id = convosDataMatch[1];
        const convosPane = conversationsService.getConversationsPane(id);
        if (!convosPane) return respond(404, { error: 'Conversations pane not found' });
        const depth = parseInt(query.depth) || 0;
        const conversations = await conversationsService.scanConversations(convosPane.dirPath, Math.min(depth, 3));
        return respond(200, { conversations, dirPath: convosPane.dirPath, depth, timestamp: Date.now() });
      }

      // GET /api/conversations-panes/:id/detail?sessionId=X
      const convosDetailMatch = path.match(/^\/api\/conversations-panes\/([^/]+)\/detail$/);
      if (convosDetailMatch && method === 'GET') {
        const id = convosDetailMatch[1];
        const convosPane = conversationsService.getConversationsPane(id);
        if (!convosPane) return respond(404, { error: 'Conversations pane not found' });
        const sessionId = query.sessionId;
        if (!sessionId) return respond(400, { error: 'sessionId required' });
        const detail = await conversationsService.fetchConversationDetail(convosPane.dirPath, sessionId);
        return respond(200, detail);
      }

      // GET /api/conversations-panes/:id/extract?sessionId=X&format=Y
      const convosExtractMatch = path.match(/^\/api\/conversations-panes\/([^/]+)\/extract$/);
      if (convosExtractMatch && method === 'GET') {
        const id = convosExtractMatch[1];
        const convosPane = conversationsService.getConversationsPane(id);
        if (!convosPane) return respond(404, { error: 'Conversations pane not found' });
        const sessionId = query.sessionId;
        const format = query.format || 'markdown';
        if (!sessionId) return respond(400, { error: 'sessionId required' });
        const result = await conversationsService.extractConversation(convosPane.dirPath, sessionId, format);
        if (result.error) return respond(404, result);
        return respond(200, result);
      }

      const convosPaneMatch = path.match(/^\/api\/conversations-panes\/([^/]+)$/);
      if (convosPaneMatch) {
        const id = convosPaneMatch[1];
        if (method === 'PATCH') {
          const updates = {};
          if (body.dirPath !== undefined) updates.dirPath = body.dirPath;
          conversationsService.updateConversationsPane(id, updates);
          return respond(200, { success: true });
        }
        if (method === 'DELETE') {
          conversationsService.deleteConversationsPane(id);
          return respond(200, { success: true });
        }
      }

      // Folder pane routes: PATCH/DELETE /api/folder-panes/:id
      const folderPaneMatch = path.match(/^\/api\/folder-panes\/([^/]+)$/);
      if (folderPaneMatch) {
        const id = folderPaneMatch[1];
        if (method === 'PATCH') {
          const updates = {};
          if (body.folderPath !== undefined) updates.folderPath = body.folderPath;
          const pane = folderPaneService.updateFolderPane(id, updates);
          return respond(200, pane);
        }
        if (method === 'DELETE') {
          folderPaneService.deleteFolderPane(id);
          return respond(200, { success: true });
        }
      }

      // If no route matched
      respond(404, { error: `Route not found: ${method} ${path}` });

    } catch (error) {
      console.error(`[MessageRouter] Error handling ${method} ${path}:`, error);
      // A file too large to send back is the caller asking for too much, not
      // the agent failing. Reported as 413 wherever it surfaces — reading a
      // file directly, or opening a file pane, which reads one on the way.
      if (error.code === 'EFBIG') {
        respond(413, { error: error.message, code: 'EFBIG' });
        return;
      }
      respond(500, { error: error.message || 'Internal server error' });
    }
  }

  /**
   * Main message handler — dispatches terminal messages and REST-over-WS requests.
   */
  return async function handleMessage(message) {
    const { type } = message;

    // Terminal messages
    if (terminalHandlers[type]) {
      try {
        await terminalHandlers[type](message.payload);
      } catch (error) {
        console.error(`[MessageRouter] Error handling ${type}:`, error);
      }
      return;
    }

    // REST-over-WS request
    if (type === MSG.REQUEST) {
      await handleRequest(message);
      return;
    }

    // Update notifications
    if (type === 'update:available') {
      console.log(`[Agent] Update available: ${message.payload?.currentVersion} → ${message.payload?.latestVersion}`);
      return;
    }

    if (type === 'update:install') {
      console.log('[Agent] Update requested by user, starting self-update...');
      performUpdate((status) => {
        sendToRelay('update:progress', { status });
      }).catch(err => {
        console.error('[Agent] Update failed:', err.message);
      });
      return;
    }

    console.warn(`[MessageRouter] Unknown message type: ${type}`);
  };
}
