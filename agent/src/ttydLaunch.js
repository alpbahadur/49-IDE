/**
 * How the agent launches and talks to ttyd. Kept free of side effects so the
 * tests exercise the exact arguments terminalManager uses.
 */

export const TTYD_BIND_HOST = '127.0.0.1';

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
