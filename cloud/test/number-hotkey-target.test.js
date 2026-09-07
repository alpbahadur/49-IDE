import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNumberHotkeyTarget } from '../src-client/modules/number-hotkeys.js';

/**
 * Tab+1..9 resolved nothing for a checkpoint pane whenever the "Pane Number
 * Hotkeys" setting was off, which is its default. The number lookup dropped
 * every pane from the pool when the setting was off, checkpoints included, so
 * the chord fell through to projects, matched nothing and returned silently.
 *
 * The checkpoint pane renders its own "Tab+N" badge under a class the setting
 * does not hide, so the app was advertising a shortcut it then ignored. The
 * setting governs pane header chrome; a checkpoint is a navigation target, the
 * same category as a project, and projects were already exempt.
 */

const pane = (n, type = 'terminal') => ({ id: `p${n}`, shortcutNumber: n, type });
const project = (n) => ({ id: `prj${n}`, shortcutNumber: n });

test('a checkpoint pane answers Tab+N with the setting off', () => {
  const hit = resolveNumberHotkeyTarget({
    panes: [pane(3, 'checkpoint')],
    projects: [],
    num: 3,
    paneHotkeysEnabled: false,
  });
  assert.deepEqual(hit, { kind: 'checkpoint', target: pane(3, 'checkpoint') });
});

test('a checkpoint pane answers Tab+N with the setting on', () => {
  const hit = resolveNumberHotkeyTarget({
    panes: [pane(3, 'checkpoint')],
    projects: [],
    num: 3,
    paneHotkeysEnabled: true,
  });
  assert.equal(hit.kind, 'checkpoint');
});

test('an ordinary pane stays gated by the setting', () => {
  // The behaviour the setting exists for, and what must not regress.
  const panes = [pane(2)];
  assert.equal(resolveNumberHotkeyTarget({ panes, projects: [], num: 2, paneHotkeysEnabled: false }), null);
  assert.deepEqual(
    resolveNumberHotkeyTarget({ panes, projects: [], num: 2, paneHotkeysEnabled: true }),
    { kind: 'pane', target: pane(2) },
  );
});

test('a gated pane yields its number to a project rather than swallowing the key', () => {
  // Panes and projects share one pool. A pane removed by the setting must not
  // shadow a project holding the same number.
  const hit = resolveNumberHotkeyTarget({
    panes: [pane(4)],
    projects: [project(4)],
    num: 4,
    paneHotkeysEnabled: false,
  });
  assert.deepEqual(hit, { kind: 'project', target: project(4) });
});

test('a pane wins a tie with a project when the setting is on', () => {
  const hit = resolveNumberHotkeyTarget({
    panes: [pane(4)],
    projects: [project(4)],
    num: 4,
    paneHotkeysEnabled: true,
  });
  assert.equal(hit.kind, 'pane');
});

test('a checkpoint wins a tie with a project even when panes are gated', () => {
  const hit = resolveNumberHotkeyTarget({
    panes: [pane(5, 'checkpoint')],
    projects: [project(5)],
    num: 5,
    paneHotkeysEnabled: false,
  });
  assert.equal(hit.kind, 'checkpoint');
});

test('projects keep their numbers either way', () => {
  for (const paneHotkeysEnabled of [true, false]) {
    const hit = resolveNumberHotkeyTarget({ panes: [], projects: [project(7)], num: 7, paneHotkeysEnabled });
    assert.deepEqual(hit, { kind: 'project', target: project(7) });
  }
});

test('an unclaimed number resolves to nothing', () => {
  assert.equal(
    resolveNumberHotkeyTarget({ panes: [pane(1)], projects: [project(2)], num: 9, paneHotkeysEnabled: true }),
    null,
  );
});

test('empty canvas and missing collections are safe', () => {
  assert.equal(resolveNumberHotkeyTarget({ num: 1 }), null);
  assert.equal(resolveNumberHotkeyTarget({ panes: [], projects: [], num: 1, paneHotkeysEnabled: false }), null);
});
