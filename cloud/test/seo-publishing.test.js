import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { createSeoPublishingRouter } from '../src/seo/publishing.js';

const fixturePath = new URL('./fixtures/seo-python-payload.json', import.meta.url);
const fixtureText = readFileSync(fixturePath, 'utf8').trim();
const fixture = JSON.parse(fixtureText);
const cloudIndex = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const TOKEN = 'seo-receiver-test-token';

function enabledEnv(databasePath, overrides = {}) {
  return {
    SEO_RECEIVER_TOKEN: TOKEN,
    SEO_PUBLIC_ORIGIN: 'https://49agents.com',
    SEO_DATABASE_PATH: databasePath,
    SEO_FORM_ACTION_ORIGINS: 'https://forms.example.test',
    ...overrides,
  };
}

async function withServer(options, callback) {
  const app = express();
  app.use((req, res, next) => {
    if (req.headers['x-test-host']) req.headers.host = req.headers['x-test-host'];
    else if (req.headers.host?.startsWith('127.0.0.1:')) req.headers.host = '49agents.com';
    next();
  });
  app.use(createSeoPublishingRouter(options));
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function requestOptions(body, headers = {}) {
  return {
    method: 'POST',
    headers: { Host: '49agents.com', 'Content-Type': 'application/json', 'Idempotency-Key': fixture.event_id, ...headers },
    body,
    redirect: 'manual',
  };
}

function temporaryDir(t) {
  const dir = mkdtempSync(join(tmpdir(), '49agents-seo-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('disabled connector and same-database configuration do not create or alter a database', async (t) => {
  const dir = temporaryDir(t);
  const disabledPath = join(dir, 'disabled.sqlite3');
  const userDbPath = join(dir, 'users.sqlite3');
  const userDb = new Database(userDbPath);
  userDb.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep');");
  userDb.close();

  await withServer({ env: { SEO_DATABASE_PATH: disabledPath, SEO_PUBLIC_ORIGIN: 'https://49agents.com' }, userDatabasePath: userDbPath }, async (base) => {
    const response = await fetch(`${base}/api/seo/v1/events/${fixture.event_id}`, { headers: { Host: '49agents.com' } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { detail: { error: 'not_found' } });
  });
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(disabledPath)), false);

  await withServer({ env: enabledEnv(userDbPath), userDatabasePath: userDbPath }, async (base) => {
    const response = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText));
    assert.equal(response.status, 404);
  });
  const verifyUserDb = new Database(userDbPath, { readonly: true });
  assert.deepEqual(verifyUserDb.prepare('SELECT value FROM marker').get(), { value: 'keep' });
  assert.equal(verifyUserDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles'").get(), undefined);
  verifyUserDb.close();
});

test('connector routing is mounted before landing routing and the general JSON parser', () => {
  const seoMount = cloudIndex.indexOf('app.use(createSeoPublishingRouter');
  assert.ok(seoMount >= 0);
  assert.ok(seoMount < cloudIndex.indexOf('// Landing page routing'));
  assert.ok(seoMount < cloudIndex.indexOf('app.use(express.json({ limit: \'16kb\' }))'));
  assert.ok(seoMount < cloudIndex.indexOf('setupApiRoutes(app)'));
});

test('wrong bearer token is rejected before creating the isolated database', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const response = await fetch(`${base}/api/seo/v1/events/${fixture.event_id}`, { headers: { Host: '49agents.com', Authorization: 'Bearer wrong' } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { detail: { error: 'unauthorized' } });
  });
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(databasePath)), false);
});

test('unknown envelopes and malformed article IDs, revisions, and canonical URLs are rejected', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const unknownEnvelope = JSON.parse(fixtureText);
    unknownEnvelope.debug = true;
    const unknownResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(JSON.stringify(unknownEnvelope), { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(unknownResponse.status, 422);
    assert.deepEqual(await unknownResponse.json(), { detail: { error: 'invalid_envelope' } });

    const invalidId = JSON.parse(fixtureText);
    invalidId.article_id = 'not-a-uuid';
    const idResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(JSON.stringify(invalidId), { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(idResponse.status, 422);
    assert.deepEqual(await idResponse.json(), { detail: { error: 'invalid_identity' } });

    const floatRevision = fixtureText.replace('"revision":1', '"revision":1.0');
    const revisionResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(floatRevision, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(revisionResponse.status, 422);
    assert.deepEqual(await revisionResponse.json(), { detail: { error: 'invalid_identity' } });

    const invalidCanonical = fixtureText.replace('https://49agents.com/articles/all-blocks-python-fixture', 'https://elsewhere.example/articles/all-blocks-python-fixture');
    const canonicalResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(invalidCanonical, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(canonicalResponse.status, 422);
    assert.deepEqual(await canonicalResponse.json(), { detail: { error: 'canonical_mismatch' } });
  });
});

test('Python producer payload hash and renderer accept all 30 block types, preserving float identity', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  const userDatabasePath = join(dir, 'users.sqlite3');
  const userDb = new Database(userDatabasePath);
  userDb.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep');");
  userDb.close();
  await withServer({ env: enabledEnv(databasePath), userDatabasePath }, async (base) => {
    const response = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.deepEqual(receipt, {
      event_id: fixture.event_id,
      remote_id: fixture.article_id,
      public_url: 'https://49agents.com/articles/all-blocks-python-fixture',
      revision: 1,
      payload_hash: '644d3945a6a82b65bb8eb0b6881d3409626eb5ba7aad4aae3f600abc4abc86e0',
    });

    const replay = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);

    const seoDb = new Database(databasePath, { readonly: true });
    assert.equal(seoDb.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
    assert.equal(seoDb.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
    seoDb.close();
    const unchangedUserDb = new Database(userDatabasePath, { readonly: true });
    assert.deepEqual(unchangedUserDb.prepare('SELECT value FROM marker').get(), { value: 'keep' });
    assert.equal(unchangedUserDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles'").get(), undefined);
    unchangedUserDb.close();
  });
});

test('event lookup returns durable receipt and health-test 404 shape; other hosts cannot read it', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const accepted = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(accepted.status, 201);

    const found = await fetch(`${base}/api/seo/v1/events/${fixture.event_id}`, { headers: { Host: '49agents.com', Authorization: `Bearer ${TOKEN}` } });
    assert.equal(found.status, 200);
    assert.deepEqual((await found.json()).payload_hash, fixture.payload_hash);

    const missing = await fetch(`${base}/api/seo/v1/events/33333333-3333-4333-8333-333333333333`, { headers: { Host: '49agents.com', Authorization: `Bearer ${TOKEN}` } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { detail: { error: 'not_found' } });

    const hiddenApi = await fetch(`${base}/api/seo/v1/events/${fixture.event_id}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Test-Host': 'app.49agents.com' } });
    assert.equal(hiddenApi.status, 404);
    assert.deepEqual(await hiddenApi.json(), { detail: { error: 'not_found' } });
    const hiddenArticle = await fetch(`${base}/articles/all-blocks-python-fixture`, { headers: { 'X-Test-Host': 'app.49agents.com' } });
    assert.equal(hiddenArticle.status, 404);
    assert.deepEqual(await hiddenArticle.json(), { detail: { error: 'not_found' } });
    const malformedHost = await fetch(`${base}/api/seo/v1/events/${fixture.event_id}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Test-Host': '49agents.com?unexpected=1' } });
    assert.equal(malformedHost.status, 404);
    assert.deepEqual(await malformedHost.json(), { detail: { error: 'not_found' } });
  });
});

test('hash mismatch, event replay conflict, stale revision, and slug conflict are rejected', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const first = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(first.status, 201);

    const tampered = fixtureText.replace('Python-generated contract fixture', 'tampered contract fixture');
    const badHash = await fetch(`${base}/api/seo/v1/articles`, requestOptions(tampered, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(badHash.status, 409);
    assert.deepEqual(await badHash.json(), { detail: { error: 'payload_hash_mismatch' } });

    const db = new Database(databasePath);
    db.prepare('UPDATE events SET payload_hash=? WHERE event_id=?').run('a'.repeat(64), fixture.event_id);
    const replayConflict = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(replayConflict.status, 409);
    assert.deepEqual(await replayConflict.json(), { detail: { error: 'event_payload_conflict' } });

    db.prepare('DELETE FROM events WHERE event_id=?').run(fixture.event_id);
    db.prepare('UPDATE articles SET revision=9 WHERE article_id=?').run(fixture.article_id);
    const stale = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { detail: { error: 'stale_revision' } });

    db.prepare('DELETE FROM articles WHERE article_id=?').run(fixture.article_id);
    db.prepare('INSERT INTO articles(article_id,revision,slug,title,description,blocks_json,canonical_url,payload_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      '44444444-4444-4444-8444-444444444444', 1, fixture.article.slug, 'Reserved', 'Reserved slug', '[]', fixture.article.canonical_url, 'b'.repeat(64), new Date().toISOString(),
    );
    const collision = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(collision.status, 409);
    assert.deepEqual(await collision.json(), { detail: { error: 'slug_conflict' } });
    db.close();
  });
});

test('hostile markup, script URLs, and unknown attributes cannot enter publication', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const executableHtml = JSON.parse(fixtureText);
    executableHtml.article.rendered_html = '<script>alert(1)</script>';
    const htmlResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(JSON.stringify(executableHtml), { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(htmlResponse.status, 422);
    assert.deepEqual(await htmlResponse.json(), { detail: { error: 'rendered_html_mismatch' } });

    const unsafeUrl = fixtureText.replace('"url":"/articles"', '"url":"javascript:alert(1)"');
    const urlResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(unsafeUrl, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(urlResponse.status, 422);
    assert.deepEqual(await urlResponse.json(), { detail: { error: 'invalid_blocks' } });

    const unknownAttribute = fixtureText.replace('"type":"paragraph"', '"onload":"alert(1)","type":"paragraph"');
    const attributeResponse = await fetch(`${base}/api/seo/v1/articles`, requestOptions(unknownAttribute, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(attributeResponse.status, 422);
    assert.deepEqual(await attributeResponse.json(), { detail: { error: 'invalid_blocks' } });
  });
});

test('form CSP permits only configured safe HTTPS action origins', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const allowed = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(allowed.status, 201);
    assert.match(allowed.headers.get('content-security-policy'), /form-action 'self' https:\/\/forms\.example\.test/);

    const unlistedForm = fixtureText.replace('https://forms.example.test/submit', 'https://attacker.example/submit');
    const rejected = await fetch(`${base}/api/seo/v1/articles`, requestOptions(unlistedForm, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(rejected.status, 422);
    assert.deepEqual(await rejected.json(), { detail: { error: 'invalid_blocks' } });
  });

  const noFormsPath = join(dir, 'no-forms.sqlite3');
  const noFormsEnv = enabledEnv(noFormsPath);
  delete noFormsEnv.SEO_FORM_ACTION_ORIGINS;
  await withServer({ env: noFormsEnv, userDatabasePath: join(dir, 'users-no-forms.sqlite3') }, async (base) => {
    const rejected = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(rejected.status, 422);
    assert.deepEqual(await rejected.json(), { detail: { error: 'invalid_blocks' } });

    const listing = await fetch(`${base}/articles`);
    assert.equal(listing.status, 200);
    const policy = listing.headers.get('content-security-policy');
    assert.match(policy, /form-action 'self'/);
    assert.doesNotMatch(policy, /forms\.example\.test|attacker\.example/);
  });
});

test('article pages escape metadata, include canonical markers, listing, sitemap, and fixed local interactions', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const published = await fetch(`${base}/api/seo/v1/articles`, requestOptions(fixtureText, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(published.status, 201);

    const pageResponse = await fetch(`${base}/articles/${fixture.article.slug}`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /<link rel="canonical" href="https:\/\/49agents\.com\/articles\/all-blocks-python-fixture">/);
    assert.match(page, /<meta name="robots" content="index,follow">/);
    assert.match(page, /data-article-id="11111111-1111-4111-8111-111111111111" data-revision="1"/);
    assert.match(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(page, /<script>alert\("x"\)<\/script>/);
    assert.match(page, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt; 49Agents café &amp; 東京/);
    assert.doesNotMatch(page, /<title><script>alert\("title"\)<\/script>/);
    assert.match(page, /<h1 class="article-title">&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt; 49Agents/);
    assert.match(page, /href="\/" aria-label="49Agents home"/);

    const listingResponse = await fetch(`${base}/articles`);
    const listing = await listingResponse.text();
    assert.equal(listingResponse.status, 200);
    assert.match(listing, /href="\/articles\/all-blocks-python-fixture"/);
    assert.match(listing, /Visit 49Agents\.com/);

    const sitemapResponse = await fetch(`${base}/sitemap-seo.xml`);
    assert.equal(sitemapResponse.status, 200);
    assert.match(await sitemapResponse.text(), /https:\/\/49agents\.com\/articles\/all-blocks-python-fixture/);

    const assetResponse = await fetch(`${base}/seo-interactions.js`);
    const asset = await assetResponse.text();
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type'), /javascript/);
    assert.doesNotMatch(asset, /\bfetch\s*\(|localStorage|sessionStorage/);
    const cssResponse = await fetch(`${base}/seo-articles.css`);
    assert.equal(cssResponse.status, 200);
    assert.match(await cssResponse.text(), /@media \(max-width: 520px\)/);
  });
});

test('request body is capped at five million bytes before JSON parsing', async (t) => {
  const dir = temporaryDir(t);
  const databasePath = join(dir, 'seo.sqlite3');
  await withServer({ env: enabledEnv(databasePath), userDatabasePath: join(dir, 'users.sqlite3') }, async (base) => {
    const largeBody = ' '.repeat(5_000_001);
    const response = await fetch(`${base}/api/seo/v1/articles`, requestOptions(largeBody, { Authorization: `Bearer ${TOKEN}` }));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { detail: { error: 'request_too_large' } });
  });
});
