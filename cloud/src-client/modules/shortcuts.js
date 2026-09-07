// ─── Keyboard Shortcuts ───────────────────────────────────────────────────
// Tab chords (Tab+Q cycle, Tab+A add, Tab+D fleet, Tab+U usage, Tab+X view
// mode, Tab+1-9 jump),
// double-tap Tab for move mode, Escape handling, Ctrl +/-/0 zoom, Ctrl+S/W,
// and auto-refocus when typing with nothing focused.
//
// tabChordUsed and tabPressedInTerminal are owned here — nothing outside this
// module reads them. tabHeld stays in app.js because the wheel handlers use it
// for Tab+scroll canvas panning, so it is reached through the context.

import { isExternalInputFocused } from './utils.js';
import { setMinimapEnabled, getMinimapEnabled, hideMinimap, startMinimapLoop } from './minimap.js';
import { showSettingsModal, savePrefsToCloud } from './settings.js';
import { resolveNumberHotkeyTarget } from './number-hotkeys.js';

let _ctx = null;

export function initShortcutsDeps(ctx) { _ctx = ctx; }

export function setupKeyboardShortcuts() {
  // Tab+key chords: hold Tab, press key for shortcuts (Q=cycle, A=add, D=fleet, etc.)
  // Double-tap Tab (outside terminal): enter move mode (WASD pane navigation).
  // Tab inside terminal: passes through to terminal as normal.
  // Uses capture phase so keys are intercepted before xterm processes them.
  let tabChordUsed = false;
  let tabPressedInTerminal = false;

  document.addEventListener('keydown', (e) => {
    const state = _ctx.getState();

    // Move mode: intercept all keys. Tab gets preventDefault but flows to keyup for exit.
    if (_ctx.getMoveModeActive()) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Tab') return; // keyup handler will call exitMoveMode
      // Map WASD and arrow keys to directions
      const arrowMap = { ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd' };
      const dir = arrowMap[e.key] || e.key.toLowerCase();
      if ((dir === 'w' || dir === 'a' || dir === 's' || dir === 'd') && !e.repeat) {
        _ctx.moveModeNavigate(dir);
      } else if (e.key === 'Enter') {
        _ctx.exitMoveMode(true);   // confirm: keep zoom
      } else if (e.key === 'Escape') {
        _ctx.exitMoveMode(false);  // cancel: restore zoom
      }
      return;
    }

    if (e.key === 'Tab') {
      if (!e.repeat) {
        _ctx.setTabHeld(true);
        tabChordUsed = false;
        // Detect if a terminal pane currently has focus
        const active = document.activeElement;
        const paneEl = active && active.closest('.pane');
        const paneId = paneEl && paneEl.id.replace('pane-', '');
        const paneData = paneId && state.panes.find(p => p.id === paneId);
        tabPressedInTerminal = !!(paneData && paneData.type === 'terminal');
      }
      // Always prevent default Tab (browser tab-cycling and terminal tab insertion)
      if (!isExternalInputFocused()) {
        e.preventDefault();
      }
      return;
    }
    const tabHeld = _ctx.getTabHeld();
    if (e.key === 'q' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();

      const order = _ctx.getTabCycleOrder();
      if (order.length === 0) return;

      const currentIdx = order.findIndex(p => p.id === _ctx.getLastFocusedPaneId());
      const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % order.length;
      _ctx.panToPane(order[nextIdx].id);
      return;
    }
    if (e.key === 'a' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      const addMenu = document.getElementById('add-pane-menu');
      addMenu.classList.toggle('hidden');
      return;
    }
    // Tab+D: toggle fleet (machines) pane collapse/expand
    if (e.key === 'd' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      if (_ctx.getHudHidden()) {
        // From dot mode: unhide HUD, show only machines pane expanded
        _ctx.setHudHidden(false);
        _ctx.setFleetPaneHidden(false);
        _ctx.setAgentsPaneHidden(true);
        _ctx.setHudExpanded(true);
        const container = document.getElementById('hud-container');
        const dot = document.getElementById('hud-restore-dot');
        if (container) container.style.display = '';
        if (dot) dot.style.display = 'none';
        _ctx.applyNoHudMode(false);
        _ctx.applyPaneVisibility();
        const hudEl = document.getElementById('hud-overlay');
        if (hudEl) hudEl.classList.remove('collapsed');
        savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded(), hud_hidden: _ctx.getHudHidden() } });
        _ctx.restartHudPolling();
        _ctx.renderHud();
      } else if (_ctx.getFleetPaneHidden() || _ctx.getAgentsPaneHidden()) {
        // Selective mode: some panes individually hidden
        if (_ctx.getFleetPaneHidden()) {
          // Show this pane (expanded)
          _ctx.setFleetPaneHidden(false);
          _ctx.setHudExpanded(true);
          _ctx.applyPaneVisibility();
          const hudEl = document.getElementById('hud-overlay');
          if (hudEl) hudEl.classList.remove('collapsed');
          savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded() } });
          _ctx.restartHudPolling();
          _ctx.renderHud();
        } else {
          // Hide this pane
          _ctx.setFleetPaneHidden(true);
          _ctx.applyPaneVisibility();
          _ctx.checkAutoHideHud();
        }
      } else {
        // Normal mode: all panes visible, toggle collapsed/expanded as before
        const hudEl = document.getElementById('hud-overlay');
        if (hudEl) {
          _ctx.setHudExpanded(!_ctx.getHudExpanded());
          hudEl.classList.toggle('collapsed', !_ctx.getHudExpanded());
          savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded() } });
          _ctx.restartHudPolling();
          _ctx.renderHud();
        }
      }
      return;
    }
    // Tab+U: toggle agents (usage) pane collapse/expand
    if (e.key === 'u' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      if (_ctx.getHudHidden()) {
        // From dot mode: unhide HUD, show only usage pane expanded
        _ctx.setHudHidden(false);
        _ctx.setFleetPaneHidden(true);
        _ctx.setAgentsPaneHidden(false);
        _ctx.setAgentsHudExpanded(true);
        const container = document.getElementById('hud-container');
        const dot = document.getElementById('hud-restore-dot');
        if (container) container.style.display = '';
        if (dot) dot.style.display = 'none';
        _ctx.applyNoHudMode(false);
        _ctx.applyPaneVisibility();
        const agentsEl = document.getElementById('agents-hud');
        if (agentsEl) agentsEl.classList.remove('collapsed');
        savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded(), hud_hidden: _ctx.getHudHidden() } });
        _ctx.renderAgentsHud();
      } else if (_ctx.getFleetPaneHidden() || _ctx.getAgentsPaneHidden()) {
        // Selective mode
        if (_ctx.getAgentsPaneHidden()) {
          _ctx.setAgentsPaneHidden(false);
          _ctx.setAgentsHudExpanded(true);
          _ctx.applyPaneVisibility();
          const agentsEl = document.getElementById('agents-hud');
          if (agentsEl) agentsEl.classList.remove('collapsed');
          savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded() } });
          _ctx.renderAgentsHud();
        } else {
          _ctx.setAgentsPaneHidden(true);
          _ctx.applyPaneVisibility();
          _ctx.checkAutoHideHud();
        }
      } else {
        // Normal mode: toggle collapsed/expanded
        const agentsEl = document.getElementById('agents-hud');
        if (agentsEl) {
          _ctx.setAgentsHudExpanded(!_ctx.getAgentsHudExpanded());
          agentsEl.classList.toggle('collapsed', !_ctx.getAgentsHudExpanded());
          savePrefsToCloud({ hudState: { fleet_expanded: _ctx.getHudExpanded(), agents_expanded: _ctx.getAgentsHudExpanded(), feedback_expanded: _ctx.getFeedbackHudExpanded() } });
          _ctx.renderAgentsHud();
        }
      }
      return;
    }
    // Tab+H: toggle hide/show all HUD panes
    if (e.key === 'h' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      _ctx.toggleHudHidden();
      return;
    }

    // Tab+S: open settings modal
    if (e.key === 's' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      showSettingsModal();
      return;
    }
    // Tab+W: close focused pane (or all broadcasted if in broadcast mode)
    if (e.key === 'w' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      const selectedPaneIds = _ctx.getSelectedPaneIds();
      if (selectedPaneIds.size > 1) {
        // Broadcast mode: close all selected panes
        const idsToClose = Array.from(selectedPaneIds);
        _ctx.clearMultiSelect();
        for (const id of idsToClose) {
          _ctx.deletePane(id);
        }
      } else {
        // Single mode: close focused pane (fallback to DOM query if lastFocusedPaneId is stale)
        const targetId = _ctx.getLastFocusedPaneId() || (document.querySelector('.pane.focused')?.dataset?.paneId);
        if (targetId) {
          const targetPane = state.panes.find(p => p.id === targetId);
          if (targetPane && targetPane.tabGroupId) _ctx.closeTabInGroup(targetId);
          else _ctx.deletePane(targetId);
        }
      }
      return;
    }
    // Tab+M: toggle minimap
    if (e.key === 'm' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      setMinimapEnabled(!getMinimapEnabled());
      if (!getMinimapEnabled()) {
        hideMinimap();
      } else {
        startMinimapLoop();
      }
      return;
    }
    // Tab+X: switch between canvas and list view. Opt-out, since a chord that
    // replaces the whole view is a surprise if you hit it by accident.
    if (e.key === 'x' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      if (_ctx.getViewModeHotkeyEnabled()) _ctx.toggleViewMode();
      return;
    }
    // Tab+P: toggle projects sidebar
    if (e.key === 'p' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      _ctx.toggleProjectsSidebar();
      return;
    }
    // Tab+`: cycle to next tab in focused pane's tab group
    if (e.key === '`' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      const lastFocusedPaneId = _ctx.getLastFocusedPaneId();
      const focusedPane = lastFocusedPaneId && state.panes.find(p => p.id === lastFocusedPaneId);
      if (focusedPane && focusedPane.tabGroupId) {
        const groupPanes = _ctx.getTabGroupPanes(focusedPane.tabGroupId);
        if (groupPanes.length > 1) {
          const activeIdx = groupPanes.findIndex(p => p.tabGroupActive);
          const nextIdx = (activeIdx + 1) % groupPanes.length;
          _ctx.switchTab(groupPanes[nextIdx].id);
        }
      }
      return;
    }
    // Tab+=: create new tab in focused pane's group
    if (e.key === '=' && tabHeld) {
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      const lastFocusedPaneId = _ctx.getLastFocusedPaneId();
      if (lastFocusedPaneId) {
        const focusedPane = state.panes.find(p => p.id === lastFocusedPaneId);
        if (focusedPane && focusedPane.type === 'terminal') {
          _ctx.createTabInGroup(lastFocusedPaneId);
        }
      }
      return;
    }
    // Tab+1..9: jump to pane or project with that shortcut number (shared pool)
    if (tabHeld && e.key >= '1' && e.key <= '9') {
      const num = parseInt(e.key, 10);
      const hit = resolveNumberHotkeyTarget({
        panes: state.panes,
        projects: state.projects,
        num,
        paneHotkeysEnabled: _ctx.getPaneNumberHotkeysEnabled ? _ctx.getPaneNumberHotkeysEnabled() : true,
      });
      if (!hit) return;
      tabChordUsed = true;
      e.preventDefault();
      e.stopPropagation();
      if (hit.kind === 'checkpoint') _ctx.navigateToCheckpointPane(hit.target);
      else if (hit.kind === 'pane') _ctx.jumpToPane(hit.target);
      else _ctx.navigateToProject(hit.target);
      return;
    }
  }, true); // capture phase

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Tab') {
      const wasChord = tabChordUsed;
      const wasInTerminal = tabPressedInTerminal;
      _ctx.setTabHeld(false);
      tabChordUsed = false;
      tabPressedInTerminal = false;

      if (wasChord || isExternalInputFocused()) {
        _ctx.setLastTabUpTime(0);
        return;
      }

      // Move mode: Tab exits move mode
      if (_ctx.getMoveModeActive()) {
        _ctx.exitMoveMode(true);  // Tab = confirm (keep zoom)
        _ctx.setLastTabUpTime(0);
        return;
      }

      // Double-tap detection
      const now = Date.now();
      if (now - _ctx.getLastTabUpTime() < 300) {
        _ctx.setLastTabUpTime(0);
        _ctx.enterMoveMode();
        return;
      }
      _ctx.setLastTabUpTime(now);
      // Solo Tab (first tap): no-op, just records timestamp for double-tap detection
    }
  }, true);

  window.addEventListener('blur', () => {
    _ctx.setTabHeld(false);
    tabChordUsed = false;
    tabPressedInTerminal = false;
    if (_ctx.getMoveModeActive()) _ctx.exitMoveMode(false);
  });

  // Escape: exit mention mode or clear broadcast selection
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (_ctx.getMentionModeActive()) {
        _ctx.exitMentionMode();
        return;
      }
      if (_ctx.getSelectedPaneIds().size > 0) {
        _ctx.clearMultiSelect();
      }
    }
  });

  // Ctrl+Shift+@ → toggle mention mode
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.key === '@')) return;
    e.preventDefault();
    if (_ctx.getMentionModeActive()) {
      _ctx.exitMentionMode();
    } else {
      _ctx.enterMentionMode();
    }
  });

  // Non-Shift click outside broadcast panes clears selection
  document.addEventListener('mousedown', (e) => {
    if (e.shiftKey) return;
    if (_ctx.getSelectedPaneIds().size === 0) return;
    // Don't clear if clicking inside a broadcast-selected pane
    if (_ctx.isInsideBroadcastPane(e.target)) return;
    _ctx.clearMultiSelect();
  });

  // Ctrl/Cmd +/-/0 : pane zoom if focused, canvas zoom otherwise
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const isPlus = e.key === '=' || e.key === '+';
    const isMinus = e.key === '-';
    const isReset = e.key === '0';
    if (!isPlus && !isMinus && !isReset) return;

    e.preventDefault();
    const state = _ctx.getState();

    if (isReset) {
      const focusedPaneEl = document.querySelector('.pane.focused');
      if (focusedPaneEl) {
        const paneId = focusedPaneEl.dataset.paneId;
        const paneData = state.panes.find(p => p.id === paneId);
        if (!paneData) return;
        paneData.zoomLevel = 100;
        _ctx.applyPaneZoom(paneData, focusedPaneEl);
        _ctx.cloudSaveLayout(paneData);
      } else {
        _ctx.setZoom(1, window.innerWidth / 2, window.innerHeight / 2);
      }
      return;
    }

    const focusedPaneEl = document.querySelector('.pane.focused');
    if (focusedPaneEl) {
      const paneId = focusedPaneEl.dataset.paneId;
      const paneData = state.panes.find(p => p.id === paneId);
      if (!paneData) return;

      if (!paneData.zoomLevel) paneData.zoomLevel = 100;
      paneData.zoomLevel = isPlus
        ? Math.min(500, paneData.zoomLevel + 10)
        : Math.max(20, paneData.zoomLevel - 10);
      _ctx.applyPaneZoom(paneData, focusedPaneEl);
      _ctx.cloudSaveLayout(paneData);
    } else {
      const factor = isPlus ? 1.2 : 1 / 1.2;
      _ctx.setZoom(state.zoom * factor, window.innerWidth / 2, window.innerHeight / 2);
    }
  });

  // Ctrl/Cmd+S: save focused file pane; Ctrl/Cmd+W: close focused pane
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key !== 's' && e.key !== 'w') return;

    const focusedPaneEl = document.querySelector('.pane.focused');
    if (!focusedPaneEl) return;

    const paneId = focusedPaneEl.dataset.paneId;
    const paneData = _ctx.getState().panes.find(p => p.id === paneId);
    if (!paneData) return;

    if (e.key === 's' && paneData.type === 'file') {
      e.preventDefault();
      const saveBtn = focusedPaneEl.querySelector('.save-btn');
      if (saveBtn) saveBtn.click();
    } else if (e.key === 'w') {
      e.preventDefault();
      _ctx.deletePane(paneId);
    }
  });

  // Auto-refocus last pane when typing with nothing focused
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isExternalInputFocused()) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.closest('.pane')) return;
    if (document.querySelector('.pane.focused')) return;
    const lastFocusedPaneId = _ctx.getLastFocusedPaneId();
    if (!lastFocusedPaneId) return;
    const paneData = _ctx.getState().panes.find(p => p.id === lastFocusedPaneId);
    if (!paneData) return;

    e.preventDefault();
    e.stopPropagation();

    _ctx.focusPane(paneData);
    if (paneData.type === 'terminal') {
      _ctx.focusTerminalInput(paneData.id);
    } else if (paneData.type === 'file') {
      const edInfo = _ctx.getFileEditors().get(paneData.id);
      if (edInfo?.monacoEditor) edInfo.monacoEditor.focus();
    }
  });
}
