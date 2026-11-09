// Confluence: Copilot chats search and read Confluence pages, read only, through Atlassian's
// remote MCP server and your own OAuth login (no API token). `confluence …` in a chat comes here
// through Clearsky's door (lib/broker.mjs, ../source.mjs); the login never goes in the sandbox.
//
// Read only by construction: the server's tools are listed, and a chat can only reach the ones
// that are about Confluence and read only (the server's readOnlyHint, and no write verb in the
// name). Jira on the same server is left out on purpose: Clearsky reads Jira through acli.
//
// Tool names aren't hard-coded: Atlassian's server offers different sets per version, so each
// command picks the tool that fits by name and fills in only the arguments its schema has.

export const USAGE = `confluence search WORDS [--space KEY] [--limit 25]   pages that match
confluence cql 'CQL' [--limit 25]                     search with Confluence's query language
confluence read PAGE                                  a page as text (its id or its link)
confluence children PAGE                              pages under it
confluence comments PAGE                              its comments
confluence spaces [--limit 50]                        spaces you can see
confluence tools                                      the read-only Confluence tools offered
confluence call TOOL '{"json":"arguments"}'           one of those tools directly
Read only, as the user. Secrets are removed from what comes back.`;

const WRITE = new Set(['create', 'update', 'edit', 'delete', 'remove', 'add', 'post', 'put', 'patch', 'set', 'move', 'archive',
  'publish', 'write', 'upload', 'transition', 'assign', 'comment', 'reply', 'restore', 'copy', 'convert', 'like', 'watch']);
// Each word of the name ("createConfluenceFooterComment" → create, confluence, footer, comment).
const isWrite = (name) => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).some((w) => WRITE.has(w));

// The tools a chat may reach: about Confluence, and read only by the server's word and ours.
// The site lookup is allowed too, as it only says which sites the login can see.
export function allowedTools(tools = []) {
  return tools.filter((t) => t && typeof t.name === 'string'
    && (/confluence/i.test(t.name) || t.name === 'getAccessibleAtlassianResources')
    && t.annotations?.readOnlyHint !== false && t.annotations?.destructiveHint !== true
    && !isWrite(t.name));
}

// The tool that does a command, by name: the most specific match first.
const PICK = {
  search: [/^searchConfluenceUsingCql$/, /confluence.*search|search.*confluence/i],
  read: [/^getConfluencePage$/, /^get.*confluence.*page$/i, /confluence.*page$/i],
  children: [/^getConfluencePageDescendants$/, /^getConfluencePageChildren$/, /confluence.*(descendant|children)/i],
  comments: [/^getConfluencePageFooterComments$/, /confluence.*footer.*comments/i, /confluence.*comments/i],
  spaces: [/^getConfluenceSpaces$/, /confluence.*spaces$/i],
};
export function pickTool(tools, cmd) {
  for (const re of PICK[cmd] || []) {
    const t = tools.find((x) => re.test(x.name));
    if (t) return t;
  }
  return null;
}

// "123456", or a page link (…/pages/123456/Title, ?pageId=123456) → "123456".
export function pageId(s) {
  const t = String(s || '').trim();
  if (/^\d{1,20}$/.test(t)) return t;
  const m = t.match(/\/pages\/(\d{1,20})(?:[/?#]|$)/) || t.match(/[?&]pageId=(\d{1,20})/);
  return m ? m[1] : null;
}

const cqlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The command a chat typed, checked: { cmd, ... } or { error }.
export function parseCommand(argv) {
  const [cmd = 'help', ...rest] = argv;
  const opts = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (/^--(space|limit)$/.test(a)) { if (rest[i + 1] === undefined) return { error: `${a} needs a value` }; opts[a.slice(2)] = rest[++i]; continue; }
    if (a.startsWith('--')) return { error: `unknown option ${a}` };
    pos.push(a);
  }
  const limit = Math.min(Math.max(Number(opts.limit) || (cmd === 'spaces' ? 50 : 25), 1), 100);
  switch (cmd) {
    case 'help': case 'tools': return { cmd };
    case 'search': {
      const words = pos.join(' ').trim();
      if (!words) return { error: 'search needs some words' };
      if (opts.space && !/^~?[\w-]{1,255}$/.test(opts.space)) return { error: '--space takes a space key' };
      const cql = `type = page AND text ~ ${cqlString(words)}${opts.space ? ` AND space = ${cqlString(opts.space)}` : ''} ORDER BY lastmodified DESC`;
      return { cmd, cql, limit };
    }
    case 'cql':
      if (pos.length !== 1 || !pos[0].trim()) return { error: 'cql needs one query, in quotes' };
      return { cmd: 'search', cql: pos[0], limit };
    case 'read': case 'children': case 'comments': {
      const id = pos.length === 1 && pageId(pos[0]);
      if (!id) return { error: `${cmd} needs one page: its id or its link` };
      return { cmd, id, limit };
    }
    case 'spaces': return { cmd, limit };
    case 'call': {
      const [tool, json = '{}', ...more] = pos;
      if (!tool || more.length) return { error: "call needs a tool and its arguments as one JSON object, in quotes" };
      let args;
      try { args = JSON.parse(json); } catch { return { error: 'the arguments are not JSON' }; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'the arguments must be a JSON object' };
      return { cmd, tool, args };
    }
    default: return { error: `unknown command ${cmd}` };
  }
}

// Arguments for a tool, from what we have, keeping only the names its schema has.
export function argsFor(tool, want) {
  const props = tool?.inputSchema?.properties || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(props, k);
  const out = {};
  const put = (names, v) => { if (v === undefined || v === null) return; const k = names.find(has); if (k) out[k] = v; };
  put(['cloudId'], want.cloudId);
  put(['cql', 'query'], want.cql);
  put(['pageId', 'id', 'contentId'], want.id);
  put(['limit', 'maxResults'], want.limit);
  const fmt = props.contentFormat || props.bodyFormat || props.format;
  if (fmt) {
    const k = has('contentFormat') ? 'contentFormat' : has('bodyFormat') ? 'bodyFormat' : 'format';
    const ok = Array.isArray(fmt.enum) ? fmt.enum.find((x) => /markdown/i.test(x)) : 'markdown';
    if (ok) out[k] = ok;
  }
  return out;
}

const MAX = 60_000;
// A tool's answer as text: its text parts joined, structured content as JSON, cut to a size a
// chat can take.
export function resultText(r) {
  const parts = (r?.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' && c.resource?.text ? c.resource.text : '')).filter(Boolean);
  let s = parts.length ? parts.join('\n') : r?.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : '';
  if (s.length > MAX) s = `${s.slice(0, MAX)}\n… (cut: ${s.length - MAX} more characters; ask for less, or read a single page)`;
  return s;
}

// The site to read, as the server's cloudId: CONFLUENCE_SITE if set ("acme.atlassian.net" or a
// link), else the one the login sees (asked once, then kept with the login).
export function siteFrom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`);
    return /^[a-z\d][a-z\d.-]*\.[a-z]{2,}$/i.test(u.hostname) ? `https://${u.hostname.toLowerCase()}` : null;
  } catch { return null; }
}

// Runs a checked command with an MCP client ({ listTools(), callTool(name, args) }).
// `site()` gives the cloudId, or null to ask the server.
export function createConfluence({ client, site = () => null, keepSite = () => {} }) {
  let toolsAt = 0, tools = null;
  const list = async () => {
    if (!tools || Date.now() - toolsAt > 10 * 60_000) { tools = allowedTools(await client.listTools()); toolsAt = Date.now(); }
    return tools;
  };
  const call = async (tool, args) => {
    const r = await client.callTool(tool.name, args);
    const text = resultText(r);
    if (r?.isError) throw new Error(`Confluence said: ${text.slice(0, 2000) || 'an error'}`);
    return text || '(nothing came back)';
  };
  const cloudId = async (ts) => {
    const s = site();
    if (s) return s;
    const t = ts.find((x) => x.name === 'getAccessibleAtlassianResources');
    if (!t) return null;
    const r = await client.callTool(t.name, {});
    let found = null;
    try { const j = JSON.parse(resultText(r)); found = (Array.isArray(j) ? j : j.resources || []).find((x) => x && (x.id || x.url)); } catch { /* not JSON */ }
    if (!found) return null;
    const id = found.url ? siteFrom(found.url) || found.id : found.id;
    keepSite(id);
    return id;
  };

  return {
    async run(c) {
      if (c.cmd === 'help') return USAGE;
      const ts = await list();
      if (c.cmd === 'tools') return ts.map((t) => `${t.name}  ${String(t.description || '').split('\n')[0].slice(0, 160)}`).join('\n') || 'The server offers no read-only Confluence tools to this login.';
      if (c.cmd === 'call') {
        const t = ts.find((x) => x.name === c.tool);
        if (!t) throw new Error(`${c.tool} is not one of the read-only Confluence tools (confluence tools lists them)`);
        const args = { ...c.args };
        if (t.inputSchema?.properties?.cloudId && !args.cloudId) args.cloudId = await cloudId(ts);
        return call(t, args);
      }
      const t = pickTool(ts, c.cmd);
      if (!t) throw new Error(`the server offers no read-only tool to ${c.cmd} (confluence tools lists what there is; try confluence call)`);
      const id = t.inputSchema?.properties?.cloudId ? await cloudId(ts) : null;
      return call(t, argsFor(t, { ...c, cloudId: id }));
    },
  };
}

// ---------------------------------------------------------------- the login

export const DEFAULT_URL = 'https://mcp.atlassian.com/v2/mcp';
// Fixed, as the client registered for it is kept with the login.
export const REDIRECT = 'http://localhost:19877/oauth/callback';

// Of the scopes the server lists, the ones that read or search Confluence, and staying logged in.
// Nothing that writes, and no Jira: the server then won't let the login do either.
export function readScopes(supported = []) {
  const keep = supported.filter((s) => (/confluence/i.test(s) && /^(read|search):/i.test(s)) || ['offline_access', 'read:me', 'read:account'].includes(s));
  return keep.join(' ');
}

export function options(env = {}) {
  const scopes = String(env.CONFLUENCE_MCP_SCOPES || '').split(/[\s,]+/).filter(Boolean).join(' ');
  return { url: String(env.CONFLUENCE_MCP_URL || '').trim() || DEFAULT_URL, site: siteFrom(env.CONFLUENCE_SITE), scope: scopes || readScopes };
}

// The login and the client, with Clearsky's MCP parts (lends.mcpOAuth, lends.mcpClient).
// `store` keeps { access_token, refresh_token, …, client, site } in a file only you can read.
export function createConfluenceMcp({ lends, store, open = (u) => lends.openUrl(u), fetchImpl = fetch, now = () => Date.now() }) {
  const { login: oauthLogin, refresh, expiresSoon } = lends.mcpOAuth;
  let opts = options({}), client = null, clientFor = '';
  const use = (env) => { opts = options(env); };
  const notIn = () => Object.assign(new Error('not logged in to Confluence; log in under Settings → Plugins → Confluence'), { auth: true });

  async function token() {
    let t = store.get();
    if (!t?.access_token) throw notIn();
    if (expiresSoon(t, now())) { t = await refresh(t, { fetchImpl, now: now() }); store.set(t); }
    return t.access_token;
  }
  function mcp() {
    if (!client || clientFor !== opts.url) {
      client = lends.mcpClient.mcpClient({ url: opts.url, token, fetchImpl, onAuth: async () => {
        const t = store.get();
        if (!t?.refresh_token) throw Object.assign(new Error('Atlassian ended the login; log in again under Settings → Plugins → Confluence'), { auth: true });
        store.set(await refresh(t, { fetchImpl, now: now() }));
      } });
      clientFor = opts.url;
    }
    return { listTools: () => client.tools(), callTool: (n, a) => client.callTool(n, a) };
  }
  const confluence = () => createConfluence({ client: mcp(), site: () => opts.site || store.get()?.site || null, keepSite: (site) => { const t = store.get(); if (t) store.set({ ...t, site }); } });

  return {
    use,
    status() {
      const t = store.get();
      if (!t?.access_token) return { loggedIn: false, detail: 'not logged in' };
      const site = opts.site || t.site;
      return { loggedIn: true, detail: `logged in ${new Date(t.at).toLocaleDateString()}${site ? `, ${new URL(site).host}` : ''}` };
    },
    async login() {
      const had = store.get();
      const t = await oauthLogin({ mcpUrl: opts.url, client: had?.client, redirectUri: REDIRECT, scope: opts.scope, open, clientName: 'Clearsky', fetchImpl, now });
      // A new login may see other sites: ask again, unless one is set.
      store.set({ ...t, site: null });
      client = null;
      const tools = allowedTools(await mcp().listTools());
      return { detail: `Logged in; ${tools.length} read-only Confluence tool${tools.length === 1 ? '' : 's'}.` };
    },
    // The client registered stays, so the next login doesn't register another.
    logout() { const t = store.get(); store.set(t?.client ? { client: t.client } : null); client = null; },
    run: (cmd) => confluence().run(cmd),
  };
}
