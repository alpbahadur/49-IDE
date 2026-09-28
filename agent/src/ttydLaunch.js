import { randomBytes } from 'crypto';

/**
 * How the agent launches and talks to ttyd. Kept free of side effects so the
 * tests exercise the exact arguments terminalManager uses.
 */

export const TTYD_BIND_HOST = '127.0.0.1';

export function generateTtydCredential() {
  return {
    user: randomBytes(9).toString('base64url'),
    pass: randomBytes(24).toString('base64url'),
  };
}

export function buildTtydArgs({ port, command }) {
  return [
    '-i', TTYD_BIND_HOST,
    '-p', String(port),
    '-W',
    ...command,
  ];
}

export function ttydUrl(port) {
  return `ws://${TTYD_BIND_HOST}:${port}/ws`;
}

function authToken(credential) {
  return Buffer.from(`${credential.user}:${credential.pass}`).toString('base64');
}

export function ttydClientOptions(credential) {
  return { headers: { Authorization: `Basic ${authToken(credential)}` } };
}

// ttyd checks the credential twice: the Authorization header on the upgrade,
// and AuthToken in the first message. Without the latter it closes with 1008.
export function ttydInitMessage(credential, cols, rows) {
  return JSON.stringify({ AuthToken: authToken(credential), columns: cols || 80, rows: rows || 24 });
}
