/**
 * Agent token verification — Placeholder for Phase 3.
 *
 * In Phase 3, agents will authenticate to the cloud relay using
 * signed JWT tokens. This module will handle verification and generation
 * of those tokens.
 */

import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { upsertUser, getUserById, getOrCreateLocalSharedUser } from '../db/users.js';
import { upsertDevAgent } from '../db/agents.js';
import { getLocalAuth } from './localAuth.js';
import { hostname as osHostname } from 'os';

// The literal 'dev' token is accepted without a signature check, so it may
// only ever be honoured by a deployment with no accounts to impersonate.
const isProduction = config.nodeEnv === 'production';
const devModeEnabled = config.authMode === 'open' && !isProduction;

function encodeSecret(secret) {
  return new TextEncoder().encode(secret);
}

/**
 * Verify an agent JWT token.
 *
 * In dev/local mode (no OAuth configured), accepts the special token 'dev'
 * and auto-authenticates as a local dev agent without requiring login.
 *
 * @param {string} token - The JWT token string
 * @param {string} [instanceKey] - Local instance the agent belongs to. Several
 *   agents can run on one machine (one per local server) during development;
 *   this keeps their dev agent IDs distinct so they do not evict each other.
 * @returns {{ agentId: string, userId: string }} Decoded agent identity
 * @throws If the token is invalid or expired
 */
/**
 * The synthetic agent ID used in dev mode. The default instance keeps the
 * original ID so existing local databases and layouts still resolve; other
 * instances get a suffixed ID of their own.
 */
function devAgentId(instanceKey) {
  if (!instanceKey || instanceKey === 'default') return 'agent_dev_local';
  return `agent_dev_local_${String(instanceKey).replace(/[^a-z0-9_-]/gi, '')}`;
}

/**
 * Resolve the dev agent identity, recording it in the agents table.
 *
 * pane_layouts.agent_id references agents(id). Dev mode does not go through
 * the pairing routes that populate that table, so without this every layout
 * save fails the foreign key and no pane position is ever persisted.
 *
 * upsertDevAgent returns the id actually stored, which differs from the
 * synthetic one when a real agent already holds this (user, hostname) pair.
 * Returning that id keeps the reference valid in both cases.
 */
function resolveDevAgent(instanceKey, userId) {
  const id = devAgentId(instanceKey);
  return upsertDevAgent(id, userId, osHostname(), process.platform);
}

export async function verifyAgentToken(token, instanceKey) {
  // Dev mode: no OAuth configured AND not production — accept 'dev' token without verification
  if (devModeEnabled && token === 'dev') {
    // Escape hatch: SKIP_CLOUD_AUTH preserves old dev-user behavior
    if (process.env.SKIP_CLOUD_AUTH) {
      const devUser = upsertUser({
        githubId: 'dev-0',
        githubLogin: 'dev-user',
        email: 'dev@localhost',
        displayName: 'Dev User',
        avatarUrl: null,
      });
      return {
        agentId: resolveDevAgent(instanceKey, devUser.id),
        userId: devUser.id,
      };
    }

    // Local mode: prefer the cloud-authenticated identity when this instance
    // has gone through that flow (see localAuth.js).
    const localAuth = getLocalAuth();
    if (localAuth) {
      const user = getUserById(localAuth.cloudUserId) || upsertUser({
        githubLogin: localAuth.githubLogin,
        email: localAuth.email,
        displayName: localAuth.displayName || 'Local User',
        avatarUrl: localAuth.avatarUrl,
      });
      return {
        agentId: resolveDevAgent(instanceKey, user.id),
        userId: user.id,
      };
    }

    // Most 'open' deployments never complete that flow — the browser instead
    // resolves through autoLocalSession's shared-identity fallback (see
    // middleware.js). Mirror that here so the agent lands on the same user
    // the browser already created, instead of refusing to connect.
    const { ensureLocalSession, getEmailAuth } = await import('./emailAuth.js');
    const { instanceId } = ensureLocalSession();
    const emailAuth = getEmailAuth();
    const user = getOrCreateLocalSharedUser(instanceId, {
      email: emailAuth?.email || null,
      displayName: emailAuth?.email ? emailAuth.email.split('@')[0] : 'Local User',
    });
    return {
      agentId: resolveDevAgent(instanceKey, user.id),
      userId: user.id,
    };
  }

  const secret = encodeSecret(config.jwt.agentSecret);
  const { payload } = await jwtVerify(token, secret);

  if (payload.type !== 'agent') {
    throw new Error('Invalid token type');
  }

  return {
    agentId: payload.sub,
    userId: payload.userId,
  };
}

/**
 * Generate a JWT token for an agent.
 * @param {string} userId - The owner user ID
 * @param {string} agentId - The agent ID
 * @param {string} hostname - The agent's hostname
 * @returns {Promise<string>} Signed JWT token string
 */
export async function generateAgentToken(userId, agentId, hostname) {
  const secret = encodeSecret(config.jwt.agentSecret);

  return new SignJWT({
    sub: agentId,
    userId,
    hostname,
    type: 'agent',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('365d') // Agent tokens are long-lived
    .sign(secret);
}
