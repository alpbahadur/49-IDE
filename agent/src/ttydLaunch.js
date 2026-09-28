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
