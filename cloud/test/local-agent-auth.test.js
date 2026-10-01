import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A self-hosted agent connects without any sign-in.
 *
 * Local mode dropped its sign-in step: the browser middleware now resolves
 * every visitor to one shared identity keyed on the instance id, and
 * local_auth (written only by the cloud OAuth callback) stays empty. The agent
 * path still required local_auth, so on a fresh install every agent was
 * refused with "Local instance not authenticated with cloud" and the canvas
 * never showed a machine. The agent must land on the same user id as the
 * browser, or the relay never pairs them.
 */

const dir = mkdtempSync(join(tmpdir(), 'local-agent-auth-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.AUTH_MODE = 'open';
delete process.env.SKIP_CLOUD_AUTH;
delete process.env.NODE_ENV;

const { initDatabase } = await import('../src/db/index.js');
const { ensureLocalAuthTable, getLocalAuth } = await import('../src/auth/localAuth.js');
const { ensureEmailAuthTable, ensureLocalSession } = await import('../src/auth/emailAuth.js');
const { getOrCreateLocalSharedUser } = await import('../src/db/users.js');
const { verifyAgentToken } = await import('../src/auth/agentAuth.js');

initDatabase();
ensureLocalAuthTable();
ensureEmailAuthTable();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a fresh local instance accepts its agent without cloud sign-in', async () => {
  assert.equal(getLocalAuth(), null, 'precondition: nobody signed in with the cloud');

  const identity = await verifyAgentToken('dev', 'default');

  assert.equal(identity.agentId, 'agent_dev_local');
  assert.ok(identity.userId);
});

test('the agent and the browser resolve to the same user', async () => {
  const { instanceId } = ensureLocalSession();
  const browserUser = getOrCreateLocalSharedUser(instanceId, { displayName: 'Local User' });

  const identity = await verifyAgentToken('dev', 'default');

  assert.equal(identity.userId, browserUser.id);
});

test('reconnecting keeps the same identity', async () => {
  const first = await verifyAgentToken('dev', 'default');
  const second = await verifyAgentToken('dev', 'default');

  assert.deepEqual(second, first);
});
