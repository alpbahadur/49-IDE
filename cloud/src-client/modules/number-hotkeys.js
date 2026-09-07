// ─── Tab+1..9 target resolution ───────────────────────────────────────────────
// Pure lookup, kept out of shortcuts.js so it is reachable from tests without
// a DOM: shortcuts.js pulls in minimap.js, which reads window at import time.

/**
 * Which navigation target Tab+<num> should act on.
 *
 * Panes and projects share one number pool, and panes win a tie. The "Pane
 * Number Hotkeys" setting removes ordinary panes from the pool, but it is a
 * pane-header-chrome setting: checkpoint panes and projects are navigation
 * targets, so they keep their numbers either way. Checkpoints in particular
 * render a "Tab+N" badge that the setting does not hide, so gating them made
 * the app advertise a shortcut it then ignored.
 *
 * Returns null when the number is unclaimed, so the caller can leave the key
 * to whatever would otherwise handle it.
 */
export function resolveNumberHotkeyTarget({ panes = [], projects = [], num, paneHotkeysEnabled = true }) {
  const pane = panes.find(p => p.shortcutNumber === num);
  if (pane && (paneHotkeysEnabled || pane.type === 'checkpoint')) {
    return { kind: pane.type === 'checkpoint' ? 'checkpoint' : 'pane', target: pane };
  }
  const project = projects.find(p => p.shortcutNumber === num);
  if (project) return { kind: 'project', target: project };
  return null;
}
