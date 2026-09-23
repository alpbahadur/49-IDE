import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { spawnSync } from 'child_process';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { existsSync } from 'fs';
import { initDatabase } from './db/index.js';
import { requireAuth, autoLocalSession } from './auth/middleware.js';
import { setupApiRoutes } from './routes/api.js';
import { setupLayoutRoutes } from './routes/layouts.js';
import { setupDownloadRoutes } from './routes/download.js';
import { setupPreferencesRoutes } from './routes/preferences.js';
import { setupAnalyticsRoutes } from './routes/analytics.js';
import { setupWebSocketRelay } from './ws/relay.js';
import { setupNotificationRoutes } from './routes/notifications.js';
import { ensureAgentTarball } from './utils/agentTarball.js';
import { setupCloudCallbackRoutes } from './auth/cloudCallback.js';
import { setupGitHubAuth } from './auth/github.js';
import { setupGoogleAuth } from './auth/google.js';
import { setupLocalGrantRoutes } from './auth/localGrant.js';
import { ensureLocalAuthTable, isLocalMode } from './auth/localAuth.js';
import { ensureEmailAuthTable, setupEmailAuthRoutes, getEmailAuth, issueEmailInstanceToken } from './auth/emailAuth.js';
import { ensureTelemetryTables, setupTelemetryIngestRoutes } from './telemetry/ingest.js';
import { initLocalTelemetryCollector } from './telemetry/localCollector.js';
import { createSeoPublishingRouter } from './seo/publishing.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const landingDir = config.landingDir ? resolve(config.landingDir) : null;

const app = express();

// Optional public article publishing is isolated from the user database and
// mounted before the app/landing hostname split and the general 16kb parser.
app.use(createSeoPublishingRouter({ userDatabasePath: config.dbPath }));

// ---------------------------------------------------------------------------
// Landing page routing (hostname-based)
// If APP_HOST is set, requests to the root domain serve the landing page
// and only APP_HOST gets the actual app.
// ---------------------------------------------------------------------------
if (landingDir && config.appHost) {
  // Vanity redirect paths — redirect to landing page root with utm_source
  const vanityRedirects = { '/twitter': 'twitter', '/x': 'twitter', '/github': 'github', '/reddit': 'reddit', '/hn': 'hackernews', '/hackernews': 'hackernews', '/linkedin': 'linkedin', '/youtube': 'youtube', '/yt': 'youtube', '/discord': 'discord' };

  app.use((req, res, next) => {
    const host = req.hostname;
    // If this is the app subdomain, continue to the app
    if (host === config.appHost) return next();

    // Vanity redirects: /twitter -> /?utm_source=twitter
    const source = vanityRedirects[req.path.toLowerCase()];
    if (source) {
      return res.redirect(302, '/?utm_source=' + source);
    }

    // Otherwise serve the landing page
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile('index.html', { root: landingDir });
    }
    // Try to serve static assets from landing dir, fall through if not found
    express.static(landingDir)(req, res, next);
  });
}

// ---------------------------------------------------------------------------
// Reverse proxy support — trust X-Forwarded-* headers so req.secure,
// req.protocol, and req.ip resolve correctly behind nginx / Cloudflare / etc.
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Required for the inline theme block that paints before first render.
          // Monaco's AMD loader config used to be the reason; it now lives in
          // modules/lazy-deps.js, but the CDN hosts are still needed there
          // because the loader is injected at runtime rather than declared.
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        workerSrc: ["'self'", "blob:"],  // Monaco web workers
        frameSrc: ["'self'", "https:"],  // Iframe panes
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding iframes in the canvas
  })
);

const allowedOrigins = config.nodeEnv === 'production'
  ? [`https://${config.cloudHost}`, ...(config.appHost ? [`https://${config.appHost}`] : [])]
  : true;

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(cookieParser());

// Load extension early routes (e.g. webhooks needing raw body) before express.json()
{
  const _extSetup = resolve(__dirname, '..', '..', 'extensions', 'setup.js');
  if (existsSync(_extSetup)) {
    try {
      const _ext = await import(_extSetup);
      if (_ext.setupEarlyRoutes) _ext.setupEarlyRoutes(app);
    } catch (_err) { console.warn('[cloud] Early extension routes skipped:', _err.message); }
  }
}

app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Agent download routes (public -- no requireAuth)
// ---------------------------------------------------------------------------
setupDownloadRoutes(app);

// ---------------------------------------------------------------------------
// Auth routes (public -- no requireAuth)
// ---------------------------------------------------------------------------
// Which door this deployment has depends on config.authMode (see config.js).
//
// 'oauth' — the hosted relay. GitHub, Google and guest sessions are all
//   registered, and setupGitHubAuth owns /auth/logout (it sends the visitor
//   back to the sign-in page, which is where they can act next).
// 'open'  — local or self-hosted. There is no sign-in, so there are no
//   provider routes and logout just drops the cookies and returns to the app,
//   where autoLocalSession mints a fresh shared identity on the next request.
if (config.authMode === 'oauth') {
  setupGitHubAuth(app);
  setupGoogleAuth(app);
  // The cloud half of the local-instance bridge. Only a deployment with real
  // accounts can grant one; an 'open' instance is the client of this flow.
  setupLocalGrantRoutes(app);
} else {
  const clearSessionCookies = (req, res) => {
    res.clearCookie('tc_access', { path: '/' });
    res.clearCookie('tc_refresh', { path: '/' });
    res.redirect('/');
  };
  app.post('/auth/logout', clearSessionCookies);
  app.get('/auth/logout', clearSessionCookies);
}

setupCloudCallbackRoutes(app);
setupEmailAuthRoutes(app);

// Telemetry ingest + admin export. Registered in every mode: on Railway these
// receive from local instances, and a local instance pointed at itself (for
// development) needs the same routes present.
setupTelemetryIngestRoutes(app);

// Auth mode endpoint (public — tells the login page if we're local or cloud)
app.get('/api/auth/mode', (req, res) => {
  res.json({
    mode: isLocalMode() ? 'local' : 'cloud',
    cloudAuthUrl: isLocalMode() ? config.cloudAuthUrl : undefined,
  });
});

/**
 * How a *second* machine can reach this server.
 *
 * The install command the Add Machine dialog hands out embeds the browser's
 * own origin, which is fine on a hosted relay but wrong for a self-hosted
 * instance: the user is looking at http://localhost, and pasting that on
 * another machine points the agent back at itself.
 *
 * So the server reports its own reachable address. loopbackOnly also tells the
 * dialog when the answer is "it cannot be reached at all yet" — the local-mode
 * default binds 127.0.0.1, and the user has to opt into a LAN bind first.
 */
app.get('/api/network', (req, res) => {
  const loopbackOnly = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1';

  let lanAddress = null;
  try {
    const nets = networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const a of addrs || []) {
        // Node <18 reports family as the string 'IPv4', newer as the number 4.
        const isV4 = a.family === 'IPv4' || a.family === 4;
        if (isV4 && !a.internal && !lanAddress) lanAddress = a.address;
      }
    }
  } catch {
    // Interface enumeration is best-effort; the dialog copes with null.
  }

  res.json({
    loopbackOnly,
    lanAddress,
    port: config.port,
    host: config.host,
  });
});

// ---------------------------------------------------------------------------
// The sign-in page. Only 'oauth' deployments have one; an 'open' deployment
// issues its shared session on first request and asks for consent inside the
// app later, so a stale /login bookmark there goes straight through.
// ---------------------------------------------------------------------------
if (config.authMode === 'oauth') {
  app.get('/login', (req, res) => res.sendFile('login.html', { root: publicDir }));
} else {
  app.get('/login', (req, res) => res.redirect('/'));
}

// Telemetry consent page, reachable only via the local-instance-to-cloud
// relay flow in cloudCallback.js (a local machine authenticating against the
// separately-hosted managed cloud) — unrelated to this deployment's own
// visitor session, which never gates on OAuth.
app.get('/consent', (req, res) => {
  res.sendFile('consent.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// API routes (protected -- requireAuth is applied inside setupApiRoutes)
// ---------------------------------------------------------------------------
setupApiRoutes(app);

// ---------------------------------------------------------------------------
// Layout persistence routes (cloud-direct, not relayed through agents)
// ---------------------------------------------------------------------------
setupLayoutRoutes(app);

// ---------------------------------------------------------------------------
// User preferences routes (cloud-direct)
// ---------------------------------------------------------------------------
setupPreferencesRoutes(app);

// ---------------------------------------------------------------------------
// Analytics routes (public tracking only — admin routes on Tailscale server)
// ---------------------------------------------------------------------------
setupAnalyticsRoutes(app);

// ---------------------------------------------------------------------------
// Feedback proxy (local mode only — forwards /api/messages to cloud server)
// ---------------------------------------------------------------------------
if (isLocalMode()) {
  const { getLocalAuth } = await import('./auth/localAuth.js');

  async function getBearerToken() {
    // Prefer OAuth cloud token; fall back to email instance token
    const localAuth = getLocalAuth();
    if (localAuth && localAuth.cloudToken) return localAuth.cloudToken;
    const emailAuth = getEmailAuth();
    if (emailAuth) return issueEmailInstanceToken(emailAuth.instanceId, emailAuth.email);
    return null;
  }

  async function proxyToCloud(req, res) {
    const token = await getBearerToken();
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated with cloud' });
    }
    const cloudUrl = config.cloudAuthUrl;
    const url = `${cloudUrl}${req.originalUrl}`;
    const opts = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    };
    if (req.method !== 'GET' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    try {
      const resp = await fetch(url, opts);
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err) {
      console.error('[feedback-proxy] Error:', err.message);
      res.status(502).json({ error: 'Cloud server unreachable' });
    }
  }

  app.get('/api/messages', proxyToCloud);
  app.post('/api/messages', proxyToCloud);
  app.get('/api/messages/unread-count', proxyToCloud);
  app.post('/api/messages/mark-read', proxyToCloud);
}

// ---------------------------------------------------------------------------
// Main app entry point.
//
// On an 'open' deployment a fresh visitor gets the shared identity on first
// request (autoLocalSession) and meets the consent modal ten minutes later,
// rather than being stopped at a sign-in screen before doing anything.
//
// On the hosted relay they must sign in first. This is not a policy choice:
// the relay pairs browsers to agents by user id, so a visitor without a real
// identity has no machines to be shown and no way to reach the ones they own
// from a second device.
// ---------------------------------------------------------------------------
const appEntryGuard = config.authMode === 'oauth' ? requireAuth : autoLocalSession;
app.get('/', appEntryGuard, (req, res) => res.sendFile('index.html', { root: publicDir }));

// ---------------------------------------------------------------------------
// Static assets (JS, CSS, fonts, lib/) -- served without auth.
// Only HTML entry points are protected above.
// ---------------------------------------------------------------------------
app.use('/', express.static(publicDir, {
  index: false, // Don't auto-serve index.html; we handle / above
}));

// ---------------------------------------------------------------------------
// Interactive tutorial (no auth required)
// ---------------------------------------------------------------------------
app.get('/tutorial', (req, res) => {
  res.sendFile('tutorial.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// Agent pairing page (auth required)
// ---------------------------------------------------------------------------
app.get('/pair', requireAuth, (req, res) => {
  res.sendFile('pair.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// Initialize database and start server with WebSocket relay
// ---------------------------------------------------------------------------
async function start() {
  initDatabase();
  ensureLocalAuthTable();
  ensureEmailAuthTable();
  ensureTelemetryTables();
  initLocalTelemetryCollector();

  // Build the downloadable agent tarball if it is missing or out of date, and
  // drop builds that have gone untouched for days.
  const dlDir = resolve(__dirname, '..', 'dl');
  ensureAgentTarball(resolve(__dirname, '..', '..'), dlDir);

  // Read latest agent version from the tarball
  let latestAgentVersion = null;
  try {
    const tarballPath = join(dlDir, '49-agent.tar.gz');
    const result = spawnSync('tar', ['xzf', tarballPath, '--to-stdout', 'agent/package.json'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.stderr || 'tar extraction failed');
    latestAgentVersion = JSON.parse(result.stdout).version || null;
    console.log(`[cloud] Latest agent version from tarball: ${latestAgentVersion}`);
  } catch (err) {
    console.warn('[cloud] Could not read agent version from tarball:', err.message);
  }


  // Create HTTP server from Express app so we can handle WebSocket upgrades
  const server = createServer(app);

  // Set up the WebSocket relay (handles /ws and /agent-ws upgrade routes)
  const { userAgents, userBrowsers } = setupWebSocketRelay(server, { latestAgentVersion });

  // Notification routes (user-facing: fetch + dismiss)
  setupNotificationRoutes(app);

  // Load extensions if present (private/cloud-only features)
  const extensionsDir = resolve(__dirname, '..', '..', 'extensions');
  if (existsSync(resolve(extensionsDir, 'setup.js'))) {
    try {
      const ext = await import(resolve(extensionsDir, 'setup.js'));
      ext.default({ app, server, userAgents, userBrowsers, publicDir });
      console.log('[cloud] Extensions loaded');
    } catch (err) {
      console.error('[cloud] Failed to load extensions:', err.message);
    }
  }

  // Catch-all for unmatched routes. Local mode has no login page to fall back
  // on, so it lands in the app instead.
  // Must be registered AFTER extensions so their routes take priority
  app.get('*', (req, res) => {
    res.redirect(isLocalMode() ? '/' : '/login');
  });

  server.listen(config.port, config.host, () => {
    console.log(`[cloud] 49Agents Cloud Server`);
    console.log(`[cloud] Listening on http://${config.host}:${config.port}`);
    console.log(`[cloud] Environment: ${config.nodeEnv}`);
    // Local mode now binds loopback by default, which stops a LAN neighbour
    // registering as your agent. Anyone who *wants* to reach this box from
    // another device needs to know how to get the old behaviour back.
    if (isLocalMode() && config.host === '127.0.0.1') {
      console.log(`[cloud] Local mode: reachable from this machine only.`);
      console.log(`[cloud] To reach it from another device, set HOST=0.0.0.0 (only on a network you trust).`);
    }
  });
}

start();

export default app;
