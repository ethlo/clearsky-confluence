// The whole plugin against a fake Atlassian: protected-resource metadata pointing at an issuer
// with a path, dynamic client registration, an authorize page that comes straight back, a token
// endpoint that checks PKCE and the registered client, and an MCP server with Atlassian-shaped
// tools, writes and Jira among them. Nothing here reaches a real Atlassian site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScopes, REDIRECT } from '../lib/confluence.mjs';
import makePlugin from '../source.mjs';
import { core } from './core.mjs';

const { sourceFromDir, PLUGIN_LENDS } = await core('lib/plugins.mjs');
const { tokenStore, register, discover } = await core('lib/mcp-oauth.mjs');

const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv.address().port)));
const freePort = async () => { const s = createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

const SCOPES = ['read:me', 'offline_access', 'read:jira:agent-interface', 'write:jira:agent-interface', 'read:confluence:agent-interface',
  'write:confluence:agent-interface', 'search:confluence:agent-interface', 'search:rovo:agent-interface'];
const TOOLS = [
  { name: 'getAccessibleAtlassianResources', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'searchConfluenceUsingCql', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { cloudId: {}, cql: {}, limit: {} } } },
  { name: 'getConfluencePage', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { cloudId: {}, pageId: {}, contentFormat: { enum: ['adf', 'markdown'] } } } },
  { name: 'createConfluencePage', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { cloudId: {}, title: {} } } },
  { name: 'getJiraIssue', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { cloudId: {}, issueIdOrKey: {} } } },
];

async function fakeAtlassian() {
  const seen = { calls: [], tokenForms: [], registrations: [], auth: null, challenge: null, clients: new Set(), revoked: null };
  let base = '', n = 0;
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/v2/mcp') return send(200, { resource: `${base}/v2/mcp`, authorization_servers: [`${base}/tenant-1`], scopes_supported: SCOPES });
    if (u.pathname === '/.well-known/oauth-authorization-server/tenant-1') return send(200, { issuer: `${base}/tenant-1`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') {
      const body = JSON.parse(await readBody(req));
      seen.registrations.push(body);
      const id = `client-${seen.registrations.length}`;
      seen.clients.add(id);
      return send(201, { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (u.pathname === '/authorize') {
      seen.auth = Object.fromEntries(u.searchParams);
      seen.challenge = u.searchParams.get('code_challenge');
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (u.pathname === '/token') {
      const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
      seen.tokenForms.push(f);
      if (!seen.clients.has(f.client_id)) return send(401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code' && !(f.code === 'the-code' && createHash('sha256').update(f.code_verifier).digest('base64url') === seen.challenge)) return send(400, { error: 'invalid_grant' });
      if (f.grant_type === 'refresh_token' && !/^refresh-\d+$/.test(f.refresh_token)) return send(400, { error: 'invalid_grant' });
      n++;
      return send(200, { access_token: `at-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer', scope: seen.auth?.scope });
    }
    if (u.pathname === '/v2/mcp') {
      const auth = req.headers.authorization || '';
      if (!/^Bearer at-\d+$/.test(auth) || auth === `Bearer ${seen.revoked}`) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/v2/mcp"` }); return res.end(); }
      const msg = JSON.parse(await readBody(req));
      seen.calls.push({ method: msg.method, name: msg.params?.name, args: msg.params?.arguments, session: req.headers['mcp-session-id'] || null });
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      const sse = (result) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`); };
      if (msg.method === 'initialize') return send(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-atlassian' } } }, { 'Mcp-Session-Id': 'sess-a' });
      if (msg.method === 'tools/list') return sse({ tools: TOOLS });
      if (msg.method === 'tools/call') {
        const { name, arguments: a } = msg.params;
        if (name === 'getAccessibleAtlassianResources') return sse({ content: [{ type: 'text', text: JSON.stringify([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: [] }]) }] });
        if (name === 'searchConfluenceUsingCql') return sse({ content: [{ type: 'text', text: JSON.stringify({ results: [{ id: '42', title: 'Release checklist', cql: a.cql }] }) }] });
        if (name === 'getConfluencePage') return sse({ content: [{ type: 'text', text: `# Release checklist (${a.pageId}, ${a.contentFormat})\n\nPassword: hunter22` }] });
        return sse({ isError: true, content: [{ type: 'text', text: `would have run ${name}` }] });
      }
    }
    send(404, { error: 'not found' });
  });
  const port = await listen(srv);
  base = `http://127.0.0.1:${port}`;
  return { base, seen, close: () => srv.close() };
}

// The plugin, its token file in a temporary folder, and a "browser" that follows the authorize
// page back to the callback. The callback is the plugin's fixed one, so the test needs its port free.
async function plugin(fake) {
  const dir = mkdtempSync(join(tmpdir(), 'confluence-mcp-'));
  const file = join(dir, 'confluence-mcp.json');
  const store = tokenStore(file);
  const opened = [];
  const lends = { ...PLUGIN_LENDS, openUrl: (u) => { opened.push(u); fetch(u).catch(() => {}); } };
  return { p: makePlugin(lends, { store }), env: { CONFLUENCE_MCP_URL: `${fake.base}/v2/mcp` }, store, opened, file };
}

test('log in with a registered client, read-only scopes, and search and read through the door', async (t) => {
  const fake = await fakeAtlassian();
  t.after(fake.close);
  const { p, env, store, opened, file } = await plugin(fake);
  assert.equal(p.logins.list(env)[0].loggedIn, false);
  assert.equal(p.doors.confluence.hint(env), '', 'no hint before the login');

  const r = await p.logins.start('atlassian', env);
  assert.match(r.detail, /Logged in; 3 read-only Confluence tools/);
  assert.equal(opened.length, 1);
  assert.equal(fake.seen.registrations.length, 1);
  assert.deepEqual(fake.seen.registrations[0].redirect_uris, [REDIRECT]);
  assert.equal(fake.seen.registrations[0].token_endpoint_auth_method, 'none');
  assert.equal(fake.seen.auth.client_id, 'client-1');
  assert.equal(fake.seen.auth.code_challenge_method, 'S256');
  assert.equal(fake.seen.auth.resource, `${fake.base}/v2/mcp`);
  assert.equal(fake.seen.auth.scope, 'read:me offline_access read:confluence:agent-interface search:confluence:agent-interface', 'nothing that writes, no Jira');
  assert.equal(store.get().client.client_id, 'client-1');
  assert.equal(statSync(file).mode & 0o077, 0, 'the login file is yours only');
  assert.equal(p.logins.list(env)[0].loggedIn, true);
  assert.match(p.doors.confluence.hint(env), /`confluence`/);

  const door = (...argv) => p.doors.confluence.run(argv, { env, chat: { mode: 'sandboxed' } });
  const s = await door('search', 'release', '--space', 'DOCS');
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.decided, 'read');
  assert.match(s.stdout, /Release checklist/);
  const call = fake.seen.calls.find((c) => c.name === 'searchConfluenceUsingCql');
  assert.deepEqual(call.args, { cloudId: 'https://acme.atlassian.net', cql: 'type = page AND text ~ "release" AND space = "DOCS" ORDER BY lastmodified DESC', limit: 25 });
  assert.equal(call.session, 'sess-a');
  assert.equal(store.get().site, 'https://acme.atlassian.net', 'the site the login sees is kept');
  const page = await door('read', 'https://acme.atlassian.net/wiki/spaces/DOCS/pages/42/Release+checklist');
  assert.match(page.stdout, /Release checklist \(42, markdown\)/);
  assert.match(p.logins.list(env)[0].detail, /acme\.atlassian\.net/);

  // Writes and Jira are refused here and never reach the server.
  const w = await door('call', 'createConfluencePage', '{"title":"x"}');
  assert.equal(w.code, 1);
  assert.equal(w.decided, 'refused');
  assert.equal((await door('call', 'getJiraIssue', '{"issueIdOrKey":"ABC-1"}')).decided, 'refused');
  assert.ok(!fake.seen.calls.some((c) => c.name === 'createConfluencePage' || c.name === 'getJiraIssue'));
  assert.doesNotMatch((await door('tools')).stdout, /create|Jira/);
  assert.equal((await door('edit', '42')).code, 2);
  assert.match((await door('help')).stdout, /confluence search/);

  // A set site wins over the one the login saw.
  await door('search', 'x');
  await p.doors.confluence.run(['search', 'y'], { env: { ...env, CONFLUENCE_SITE: 'other.atlassian.net' }, chat: { mode: 'sandboxed' } });
  assert.equal(fake.seen.calls.at(-1).args.cloudId, 'https://other.atlassian.net');

  const sp = await sourceFromDir(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(sp.area, 'work');
  assert.deepEqual(sp.manifest.doors.map((d) => d.name), ['confluence']);
});

test('refresh with the registered client; logging out keeps the client, logging in again uses it', async (t) => {
  const fake = await fakeAtlassian();
  t.after(fake.close);
  const { p, env, store } = await plugin(fake);
  await p.logins.start('atlassian', env);
  const door = (...argv) => p.doors.confluence.run(argv, { env, chat: { mode: 'sandboxed' } });

  store.set({ ...store.get(), expires_at: Date.now() - 1000 });
  assert.equal((await door('read', '7')).code, 0);
  assert.deepEqual([fake.seen.tokenForms.at(-1).grant_type, fake.seen.tokenForms.at(-1).client_id], ['refresh_token', 'client-1']);
  assert.equal(store.get().client.client_id, 'client-1', 'kept across the refresh');

  // Atlassian ends the token: one refresh on the 401, then on.
  fake.seen.revoked = store.get().access_token;
  assert.equal((await door('read', '7')).code, 0);

  await p.logins.stop('atlassian', env);
  assert.equal(p.logins.list(env)[0].loggedIn, false);
  assert.deepEqual(Object.keys(store.get()), ['client']);
  const out = await door('read', '7');
  assert.equal(out.decided, 'not logged in');
  assert.match(out.stderr, /Settings → Plugins → Confluence/);

  await p.logins.start('atlassian', env);
  assert.equal(fake.seen.registrations.length, 1, 'no second registration');
  assert.equal(fake.seen.auth.client_id, 'client-1');
});

test('registration and discovery details', async (t) => {
  const fake = await fakeAtlassian();
  t.after(fake.close);
  const ep = await discover(`${fake.base}/v2/mcp`);
  assert.equal(ep.registration_endpoint, `${fake.base}/register`);
  assert.deepEqual(ep.scopes_supported, SCOPES);
  const c = await register(ep.registration_endpoint, { redirectUri: 'http://localhost:1/cb', now: 0 });
  assert.deepEqual(c, { client_id: 'client-1', redirect_uri: 'http://localhost:1/cb', registered_at: '1970-01-01T00:00:00.000Z' });
  await assert.rejects(register(`${fake.base}/nope`, { redirectUri: 'http://localhost:1/cb' }), /wouldn't register Clearsky/);
  assert.equal(readScopes(['search:confluence', 'read:page:confluence', 'write:page:confluence', 'read:jira-work', 'offline_access']), 'search:confluence read:page:confluence offline_access');
  assert.equal(readScopes([]), '');
});
