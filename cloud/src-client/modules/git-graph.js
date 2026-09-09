// ─── Git Graph Renderer ───────────────────────────────────────────────────
// Renders git commit history as an SVG graph with lane assignment.

import { escapeHtml } from './utils.js';
import { ICON_GIT_GRAPH } from './constants.js';
import { clearPaneRefresh } from './pane-refresh.js';

let _ctx = null;

export function initGitGraphDeps(ctx) { _ctx = ctx; }

// ── SVG Graph Constants (matching mhutchie/vscode-git-graph) ──
const GG = {
  GRID_X: 16, GRID_Y: 24, OFFSET_X: 16, OFFSET_Y: 12,
  NODE_R: 4, LINE_W: 2, SHADOW_W: 4,
  COLORS: [
    '#0085d9', '#d9008f', '#00d90a', '#d98500',
    '#a300d9', '#ff0000', '#00d9cc', '#e138e8',
    '#85d900', '#dc5b23', '#6f24d6', '#ffcc00',
  ],
  // Legacy aliases used by row HTML and ASCII mode
  get ROW_H() { return this.GRID_Y; },
  get LANE_W() { return this.GRID_X; },
  get LEFT_PAD() { return this.OFFSET_X; },
};

export function renderGitGraphPane(paneData) {
  // Re-entrant: an agent reconnect re-renders every one of its panes. Stop the
  // previous poll before dropping the node it refreshes, or its timer id is
  // lost and it keeps firing against a detached subtree.
  clearPaneRefresh(_ctx.gitGraphPanes, paneData.id);

  const existingPane = document.getElementById(`pane-${paneData.id}`);
  if (existingPane) existingPane.remove();

  const pane = document.createElement('div');
  pane.className = 'pane git-graph-pane';
  pane.id = `pane-${paneData.id}`;
  pane.style.left = `${paneData.x}px`;
  pane.style.top = `${paneData.y}px`;
  pane.style.width = `${paneData.width}px`;
  pane.style.height = `${paneData.height}px`;
  pane.style.zIndex = paneData.zIndex;
  pane.dataset.paneId = paneData.id;

  if (!paneData.shortcutNumber) paneData.shortcutNumber = _ctx.getNextShortcutNumber();
  const deviceTag = paneData.device ? _ctx.deviceLabelHtml(paneData.device) : '';

  pane.innerHTML = `
    <div class="pane-header">
      <span class="pane-title git-graph-title">
        ${deviceTag}<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: middle; margin-right: 4px;">${ICON_GIT_GRAPH}</svg>
        ${paneData.repoName || 'Git Graph'}
      </span>
      ${_ctx.paneNameHtml(paneData)}
      <div class="pane-header-right">
        ${_ctx.shortcutBadgeHtml(paneData)}
        <div class="pane-zoom-controls">
          <button class="pane-zoom-btn zoom-out" aria-label="Zoom out" data-tooltip="Zoom out"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg></button>
          <button class="pane-zoom-btn zoom-in" aria-label="Zoom in" data-tooltip="Zoom in"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/></svg></button>
        </div>
        <button class="pane-expand" aria-label="Expand pane" data-tooltip="Expand"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg></button>
        <button class="pane-close" aria-label="Close pane"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>
    <div class="pane-content">
      <div class="git-graph-container">
        <div class="git-graph-header">
          <span class="git-graph-branch"></span>
          <span class="git-graph-status"></span>
          <button class="git-graph-mode-btn" data-tooltip="Toggle SVG/ASCII mode">${paneData.graphMode === 'ascii' ? 'SVG' : 'ASCII'}</button>
          <button class="git-graph-push-btn" data-tooltip="Push to remote"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: middle; margin-right: 3px;"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>Push</button>
        </div>
        <div class="git-graph-output"><span class="git-graph-loading">Loading git graph...</span></div>
      </div>
    </div>
    <div class="pane-resize-handle"></div>
    <div class="pane-resize-handle-left"></div>
  `;

  _ctx.setupPaneListeners(pane, paneData);
  setupGitGraphListeners(pane, paneData);
  _ctx.getCanvas().appendChild(pane);

  fetchGitGraphData(pane, paneData);
}

function setupGitGraphListeners(paneEl, paneData) {
  const graphOutput = paneEl.querySelector('.git-graph-output');
  const pushBtn = paneEl.querySelector('.git-graph-push-btn');
  const modeBtn = paneEl.querySelector('.git-graph-mode-btn');

  if (!paneData.graphMode) paneData.graphMode = 'svg';

  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    paneData.graphMode = paneData.graphMode === 'svg' ? 'ascii' : 'svg';
    modeBtn.textContent = paneData.graphMode === 'ascii' ? 'SVG' : 'ASCII';
    _ctx.cloudSaveLayout(paneData);
    fetchGitGraphData(paneEl, paneData);
  });

  pushBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    pushBtn.disabled = true;
    pushBtn.textContent = 'Pushing\u2026';
    pushBtn.classList.add('pushing');
    try {
      await _ctx.agentRequest('POST', `/api/git-graphs/${paneData.id}/push`, null, paneData.agentId);
      pushBtn.textContent = 'Pushed!';
      pushBtn.classList.add('push-success');
      fetchGitGraphData(paneEl, paneData);
    } catch (err) {
      pushBtn.textContent = 'Failed';
      pushBtn.classList.add('push-failed');
      console.error('[App] Git push error:', err);
    }
    setTimeout(() => {
      pushBtn.disabled = false;
      pushBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: middle; margin-right: 3px;"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>Push';
      pushBtn.classList.remove('pushing', 'push-success', 'push-failed');
    }, 2000);
  });

  graphOutput.addEventListener('mousedown', (e) => e.stopPropagation());
  graphOutput.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  graphOutput.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  const refreshInterval = setInterval(() => fetchGitGraphData(paneEl, paneData), 5000);
  _ctx.gitGraphPanes.set(paneData.id, { refreshInterval });
}

// ── mhutchie-style path-tracing layout ──
// Port of the determinePath algorithm from mhutchie/vscode-git-graph.
// Each vertex tracks nextX (next available lane) and connections (what occupies each lane).
// Branches are traced top-to-bottom, claiming lanes per-row.

export function assignLanes(commits) {
  // Legacy wrapper: runs the full layout and returns a simple lanes + branchColors map
  const layout = layoutGraph(commits);
  const lanes = new Map();
  const branchColors = new Map();
  let maxLane = 0;
  for (const v of layout.vertices) {
    if (v.x >= 0) {
      lanes.set(v.hash, v.x);
      if (v.x > maxLane) maxLane = v.x;
      if (v.branch !== null) branchColors.set(v.x, v.branch.colour);
    }
  }
  return { lanes, maxLane, branchColors };
}

function layoutGraph(commits) {
  const hashIndex = new Map();
  commits.forEach((c, i) => hashIndex.set(c.hash, i));

  // Build vertices
  const vertices = commits.map((c, i) => ({
    id: i, hash: c.hash, x: -1,
    children: [], parents: [], nextParent: 0,
    branch: null, nextX: 0,
    connections: [], // connections[laneIdx] = { connectsTo: vertexId, branch }
    isCurrent: !!(c.refs && /HEAD/.test(c.refs)),
    isMerge: c.parents.length > 1,
  }));

  // Wire parent/child edges
  for (let i = 0; i < commits.length; i++) {
    for (const ph of commits[i].parents) {
      const pi = hashIndex.get(ph);
      if (pi !== undefined) {
        vertices[i].parents.push(vertices[pi]);
        vertices[pi].children.push(vertices[i]);
      } else {
        vertices[i].parents.push(null); // parent not in graph
      }
    }
  }

  // Color management
  const availableColours = []; // availableColours[colourIdx] = endRow (row where colour became free)
  function getAvailableColour(startAt) {
    for (let i = 0; i < availableColours.length; i++) {
      if (startAt > availableColours[i]) return i;
    }
    availableColours.push(0);
    return availableColours.length - 1;
  }

  const branches = [];

  // Helper: get next available point at a vertex row
  function getNextPoint(v) {
    return { x: v.nextX, y: v.id };
  }
  function getPoint(v) {
    return { x: v.x, y: v.id };
  }
  function registerUnavailable(v, x, connectsTo, branch) {
    // Only advance nextX if this is the frontier
    while (v.connections.length <= x) v.connections.push(null);
    v.connections[x] = { connectsTo, branch };
    if (x === v.nextX) v.nextX = x + 1;
  }
  function getPointConnectingTo(v, targetVertex, onBranch) {
    for (let i = 0; i < v.connections.length; i++) {
      const c = v.connections[i];
      if (c && c.connectsTo === targetVertex.id && c.branch === onBranch) {
        return { x: i, y: v.id };
      }
    }
    return null;
  }

  function determinePath(startAt) {
    const vertex = vertices[startAt];
    const parentVertex = vertex.nextParent < vertex.parents.length ? vertex.parents[vertex.nextParent] : null;

    let lastPoint = vertex.branch === null ? getNextPoint(vertex) : getPoint(vertex);

    // CASE A: Merge line — vertex on a branch, parent on a branch
    if (parentVertex !== null && parentVertex !== null /* not null-parent */ &&
        vertex.isMerge && vertex.branch !== null && parentVertex.branch !== null) {

      const parentBranch = parentVertex.branch;
      let foundTarget = false;

      for (let i = startAt + 1; i < vertices.length; i++) {
        const cur = vertices[i];
        let curPoint = getPointConnectingTo(cur, parentVertex, parentBranch);
        if (curPoint !== null) {
          foundTarget = true;
        } else {
          curPoint = getNextPoint(cur);
        }

        parentBranch.lines.push({ p1: lastPoint, p2: curPoint });
        registerUnavailable(cur, curPoint.x, parentVertex.id, parentBranch);
        lastPoint = curPoint;

        if (foundTarget) {
          vertex.nextParent++;
          break;
        }
      }
      return;
    }

    // CASE B: Normal branch
    const branch = { colour: getAvailableColour(startAt), end: startAt, lines: [] };
    vertex.branch = branch;
    vertex.x = lastPoint.x;
    registerUnavailable(vertex, lastPoint.x, vertex.id, branch);

    let curVertex = vertex;
    let curParent = parentVertex;

    for (let i = startAt + 1; i < vertices.length; i++) {
      const cur = vertices[i];
      let curPoint;

      if (curParent === cur && cur.branch !== null) {
        curPoint = getPoint(cur);
      } else {
        curPoint = getNextPoint(cur);
      }

      branch.lines.push({ p1: lastPoint, p2: curPoint });
      registerUnavailable(cur, curPoint.x, curParent ? curParent.id : -1, branch);
      lastPoint = curPoint;

      if (curParent === cur) {
        curVertex.nextParent++;
        const wasOnBranch = cur.branch !== null;
        if (!wasOnBranch) {
          cur.branch = branch;
          cur.x = curPoint.x;
        }
        curVertex = cur;
        curParent = curVertex.nextParent < curVertex.parents.length ? curVertex.parents[curVertex.nextParent] : null;
        if (curParent === null || wasOnBranch) break;
      } else if (curParent === null) {
        // null parent (off-screen) — end branch
        curVertex.nextParent++;
        break;
      }
    }

    branch.end = vertices.length - 1;
    for (let i = vertices.length - 1; i >= startAt; i--) {
      const c = vertices[i].connections;
      let found = false;
      for (let j = 0; j < c.length; j++) {
        if (c[j] && c[j].branch === branch) { found = true; break; }
      }
      if (found) { branch.end = i; break; }
    }

    branches.push(branch);
    availableColours[branch.colour] = branch.end;
  }

  // Run layout
  let i = 0;
  while (i < vertices.length) {
    const v = vertices[i];
    if ((v.nextParent < v.parents.length && v.parents[v.nextParent] !== null) || v.branch === null) {
      determinePath(i);
    } else {
      i++;
    }
  }

  return { vertices, branches };
}

export function gitRelativeTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '1m';
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function renderSvgGitGraph(outputEl, commits, currentBranch) {
  if (!commits || commits.length === 0) {
    outputEl.innerHTML = '<span class="git-graph-loading">No commits found</span>';
    return;
  }

  const layout = layoutGraph(commits);
  const { vertices, branches } = layout;
  const d = GG.GRID_Y * 0.8; // bezier control offset

  // Compute SVG dimensions
  let maxNextX = 0;
  for (const v of vertices) if (v.nextX > maxNextX) maxNextX = v.nextX;
  const svgWidth = 2 * GG.OFFSET_X + Math.max(maxNextX - 1, 0) * GG.GRID_X;
  const totalHeight = commits.length * GG.GRID_Y;

  // Build SVG paths per branch
  const shadowPaths = [];
  const colorPaths = [];

  for (const branch of branches) {
    const colour = GG.COLORS[branch.colour % GG.COLORS.length];

    // Convert grid lines to pixel lines and simplify consecutive verticals
    const pixelLines = [];
    for (const line of branch.lines) {
      const x1 = line.p1.x * GG.GRID_X + GG.OFFSET_X;
      const y1 = line.p1.y * GG.GRID_Y + GG.OFFSET_Y;
      const x2 = line.p2.x * GG.GRID_X + GG.OFFSET_X;
      const y2 = line.p2.y * GG.GRID_Y + GG.OFFSET_Y;
      pixelLines.push({ x1, y1, x2, y2 });
    }

    // Merge consecutive vertical segments
    for (let i = 0; i < pixelLines.length - 1; ) {
      const a = pixelLines[i], b = pixelLines[i + 1];
      if (a.x1 === a.x2 && b.x1 === b.x2 && a.x2 === b.x1 && a.y2 === b.y1) {
        a.y2 = b.y2;
        pixelLines.splice(i + 1, 1);
      } else {
        i++;
      }
    }

    // Build SVG path string
    let pathD = '';
    for (let i = 0; i < pixelLines.length; i++) {
      const l = pixelLines[i];
      // Move to start if first segment or discontinuity
      if (i === 0 || l.x1 !== pixelLines[i - 1].x2 || l.y1 !== pixelLines[i - 1].y2) {
        pathD += `M${l.x1},${l.y1.toFixed(1)}`;
      }
      if (l.x1 === l.x2) {
        // Vertical
        pathD += `L${l.x2},${l.y2.toFixed(1)}`;
      } else {
        // Bezier S-curve: C x1,(y1+d) x2,(y2-d) x2,y2
        pathD += `C${l.x1},${(l.y1 + d).toFixed(1)} ${l.x2},${(l.y2 - d).toFixed(1)} ${l.x2},${l.y2.toFixed(1)}`;
      }
    }

    if (pathD) {
      shadowPaths.push(pathD);
      colorPaths.push({ d: pathD, colour });
    }
  }

  // Render SVG layers: shadows, then colored lines, then nodes
  const bgColor = '#0a0f1a';
  let svgContent = '';

  // Shadows
  for (const sp of shadowPaths) {
    svgContent += `<path d="${sp}" stroke="${bgColor}" stroke-width="${GG.SHADOW_W}" fill="none" stroke-linecap="round" stroke-opacity="0.75"/>`;
  }
  // Colored lines
  for (const cp of colorPaths) {
    svgContent += `<path d="${cp.d}" stroke="${cp.colour}" stroke-width="${GG.LINE_W}" fill="none" stroke-linecap="round"/>`;
  }
  // Nodes
  for (const v of vertices) {
    if (v.x < 0) continue;
    const cx = v.x * GG.GRID_X + GG.OFFSET_X;
    const cy = v.id * GG.GRID_Y + GG.OFFSET_Y;
    const colour = v.branch ? GG.COLORS[v.branch.colour % GG.COLORS.length] : '#808080';

    if (v.isCurrent) {
      // HEAD: open circle (background fill, colored stroke)
      svgContent += `<circle cx="${cx}" cy="${cy}" r="${GG.NODE_R}" fill="#0d1117" stroke="${colour}" stroke-width="2"/>`;
    } else {
      // Normal: filled circle, thin background stroke
      svgContent += `<circle cx="${cx}" cy="${cy}" r="${GG.NODE_R}" fill="${colour}" stroke="#0d1117" stroke-width="1" stroke-opacity="0.75"/>`;
    }
  }

  // Build row HTML
  const rowsHtml = commits.map((commit, i) => {
    const v = vertices[i];
    const colour = v.branch ? GG.COLORS[v.branch.colour % GG.COLORS.length] : '#808080';
    const timeStr = commit.timestamp ? gitRelativeTime(commit.timestamp) : '';

    let refsHtml = '';
    if (commit.refs) {
      // Match ref badge colors to graph line color for this commit
      const hexToRgb = (hex) => {
        const h = hex.replace('#', '');
        return `${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)}`;
      };
      const rgb = hexToRgb(colour);
      const refStyle = `background:rgba(${rgb},0.15);color:${colour};border:1px solid rgba(${rgb},0.3)`;
      const refParts = commit.refs.split(',').map(r => r.trim()).filter(Boolean);
      for (const ref of refParts) {
        if (ref.startsWith('HEAD -> ')) {
          refsHtml += `<span class="gg-ref gg-ref-head" style="${refStyle}">${escapeHtml(ref.replace('HEAD -> ', ''))}</span>`;
        } else if (ref.startsWith('tag: ')) {
          refsHtml += `<span class="gg-ref gg-ref-tag">${escapeHtml(ref.replace('tag: ', ''))}</span>`;
        } else if (ref.startsWith('origin/')) {
          refsHtml += `<span class="gg-ref gg-ref-remote" style="${refStyle}">${escapeHtml(ref)}</span>`;
        } else {
          refsHtml += `<span class="gg-ref gg-ref-branch" style="${refStyle}">${escapeHtml(ref)}</span>`;
        }
      }
    }

    return `<div class="gg-row" data-hash="${commit.hash}" style="height:${GG.GRID_Y}px">
      <div class="gg-graph-spacer" style="width:${svgWidth}px"></div>
      <div class="gg-info">
        <span class="gg-hash" style="color:${colour}">${commit.hash}</span>
        <span class="gg-time">${timeStr}</span>
        ${refsHtml}
        <span class="gg-subject">${escapeHtml(commit.subject || '')}</span>
        <span class="gg-author">${escapeHtml(commit.author || '')}</span>
      </div>
    </div>`;
  }).join('');

  outputEl.innerHTML = `
    <div class="gg-scroll-container">
      <svg class="gg-svg" width="${svgWidth}" height="${totalHeight}"
           viewBox="0 0 ${svgWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">
        ${svgContent}
      </svg>
      <div class="gg-rows">${rowsHtml}</div>
    </div>`;
}

export function renderAsciiGitGraph(outputEl, asciiGraph, commits) {
  if (!asciiGraph) {
    outputEl.innerHTML = '<span class="git-graph-loading">No graph data</span>';
    return;
  }

  // Build lookup from hash -> commit for enrichment
  const commitMap = new Map();
  if (commits) commits.forEach(c => commitMap.set(c.hash, c));

  // Determine lane colors: use assignLanes if commits available
  let laneColors = null;
  if (commits && commits.length > 0) {
    const { lanes, branchColors } = assignLanes(commits);
    laneColors = { lanes, branchColors };
  }

  const lines = asciiGraph.split('\n').filter(l => l.length > 0);

  const rowsHtml = lines.map(line => {
    // git log --graph --oneline produces: "graph_part hash (refs) subject"
    // Split into graph portion and text portion at the first hash match
    const hashMatch = line.match(/^([*|/\\ _.\-\s]+?)([a-f0-9]{7,})\s/);

    if (!hashMatch) {
      // Connector-only line (no commit on this line)
      const graphPart = escapeHtml(line);
      const colored = colorizeGraphChars(graphPart, laneColors, null);
      return `<div class="gg-row gg-ascii-row" style="height:${GG.ROW_H}px"><span class="gg-ascii-graph">${colored}</span></div>`;
    }

    const graphPart = hashMatch[1];
    const hash = hashMatch[2];
    const rest = line.slice(hashMatch[0].length - 1).slice(hash.length).trim();
    const commit = commitMap.get(hash);

    // Colorize graph characters
    const coloredGraph = colorizeGraphChars(escapeHtml(graphPart), laneColors, hash);

    // Get lane color for the hash
    let hashColor = '#79b8ff';
    if (laneColors && commit) {
      const lane = laneColors.lanes.get(hash);
      if (lane !== undefined) {
        const colorIdx = laneColors.branchColors.get(lane) ?? 1;
        hashColor = GG.COLORS[colorIdx];
      }
    }

    // Time
    const timeStr = commit?.timestamp ? gitRelativeTime(commit.timestamp) : '';

    // Refs from commit data (more reliable than parsing the oneline)
    let refsHtml = '';
    const refSrc = commit?.refs || '';
    if (refSrc) {
      const refParts = refSrc.split(',').map(r => r.trim()).filter(Boolean);
      for (const ref of refParts) {
        if (ref.startsWith('HEAD -> ')) {
          refsHtml += `<span class="gg-ref gg-ref-head">${escapeHtml(ref.replace('HEAD -> ', ''))}</span>`;
        } else if (ref.startsWith('tag: ')) {
          refsHtml += `<span class="gg-ref gg-ref-tag">${escapeHtml(ref.replace('tag: ', ''))}</span>`;
        } else if (ref.startsWith('origin/')) {
          refsHtml += `<span class="gg-ref gg-ref-remote">${escapeHtml(ref)}</span>`;
        } else {
          refsHtml += `<span class="gg-ref gg-ref-branch">${escapeHtml(ref)}</span>`;
        }
      }
    }

    // Subject: strip the (refs) decoration from git's oneline output
    const subject = commit?.subject || rest.replace(/\([^)]*\)\s*/, '').trim();

    // Author
    const authorHtml = commit?.author ? `<span class="gg-author">${escapeHtml(commit.author)}</span>` : '';

    return `<div class="gg-row gg-ascii-row" style="height:${GG.ROW_H}px">
      <span class="gg-ascii-graph">${coloredGraph}</span>
      <span class="gg-info">
        <span class="gg-hash" style="color:${hashColor}">${hash}</span>
        <span class="gg-time">${timeStr}</span>
        ${refsHtml}
        <span class="gg-subject">${escapeHtml(subject)}</span>
        ${authorHtml}
      </span>
    </div>`;
  }).join('');

  outputEl.innerHTML = `<div class="gg-scroll-container gg-ascii-container">${rowsHtml}</div>`;
}

// Colorize ASCII graph chars (* | / \) using lane colors
function colorizeGraphChars(graphStr, laneColors, commitHash) {
  // Color the graph symbols: * gets commit color, | / \ get lane position colors
  const graphChars = ['*', '|', '/', '\\', '_'];
  let result = '';
  let col = 0;
  for (let i = 0; i < graphStr.length; i++) {
    const ch = graphStr[i];
    if (graphChars.includes(ch)) {
      // Estimate lane from column position
      const laneIdx = Math.floor(col / 2);
      let color = GG.COLORS[laneIdx % GG.COLORS.length];

      // If we have lane data and this is the commit node, use the actual lane color
      if (ch === '*' && commitHash && laneColors) {
        const lane = laneColors.lanes.get(commitHash);
        if (lane !== undefined) {
          const colorIdx = laneColors.branchColors.get(lane) ?? 1;
          color = GG.COLORS[colorIdx];
        }
      }

      result += `<span style="color:${color}">${ch}</span>`;
    } else {
      result += ch;
    }
    col++;
  }
  return result;
}

export async function fetchGitGraphData(paneEl, paneData) {
  try {
    const outputEl = paneEl.querySelector('.git-graph-output');
    const maxCommits = 200;
    const modeParam = paneData.graphMode === 'ascii' ? '&mode=ascii' : '';
    const data = await _ctx.agentRequest('GET', `/api/git-graphs/${paneData.id}/data?maxCommits=${maxCommits}${modeParam}`, null, paneData.agentId);

    const branchEl = paneEl.querySelector('.git-graph-branch');
    const statusEl = paneEl.querySelector('.git-graph-status');

    if (data.error) {
      outputEl.innerHTML = `<span class="git-graph-error">Error: ${data.error}</span>`;
      return;
    }

    branchEl.innerHTML = `<span class="git-graph-branch-name">${escapeHtml(data.branch)}</span>`;

    if (data.clean) {
      statusEl.innerHTML = '<span class="git-graph-clean">&#x25cf; clean</span>';
    } else {
      const u = data.uncommitted;
      const details = [];
      if (u.staged > 0) details.push(`<span class="git-detail-staged">\u2713${u.staged}</span>`);
      if (u.unstaged > 0) details.push(`<span class="git-detail-modified">\u270E${u.unstaged}</span>`);
      if (u.untracked > 0) details.push(`<span class="git-detail-new">+${u.untracked}</span>`);
      const detailHtml = details.length ? `<span class="git-graph-detail">${details.join(' ')}</span>` : '';
      statusEl.innerHTML = `<span class="git-graph-dirty">&#x25cf; ${u.total} uncommitted</span>${detailHtml}`;
    }

    // Preserve scroll position across re-renders
    const scrollEl = outputEl.querySelector('.gg-scroll-container');
    const prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;

    if (data.commits) {
      if (paneData.graphMode === 'ascii' && data.asciiGraph) {
        renderAsciiGitGraph(outputEl, data.asciiGraph, data.commits);
      } else {
        renderSvgGitGraph(outputEl, data.commits, data.branch);
      }
    } else if (data.graphHtml) {
      outputEl.innerHTML = `<pre style="margin:0;padding:8px 10px;white-space:pre;font-family:inherit;font-size:inherit;color:inherit;">${data.graphHtml}</pre>`;
    }

    // Restore scroll position
    if (prevScrollTop > 0) {
      const newScrollEl = outputEl.querySelector('.gg-scroll-container');
      if (newScrollEl) newScrollEl.scrollTop = prevScrollTop;
    }
  } catch (e) {
    console.error('[App] Failed to fetch git graph data:', e);
  }
}
