import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedTools, pickTool, pageId, parseCommand, argsFor, resultText, siteFrom, createConfluence } from '../lib/confluence.mjs';
import { core } from './core.mjs';

const { parseManifest } = await core('lib/plugins.mjs');
const { validate, addFields } = await core('lib/settings.mjs');

const manifest = JSON.parse(readFileSync(new URL('../clearsky-plugin.json', import.meta.url), 'utf8'));
addFields(manifest.settings, 'Confluence');

// Tools shaped like Atlassian's, with writes and Jira mixed in.
const TOOLS = [
  { name: 'getAccessibleAtlassianResources', annotations: { readOnlyHint: true }, inputSchema: { properties: {} } },
  { name: 'searchConfluenceUsingCql', description: 'Search with CQL\nmore', annotations: { readOnlyHint: true }, inputSchema: { properties: { cloudId: {}, cql: {}, limit: {} } } },
  { name: 'getConfluencePage', annotations: { readOnlyHint: true }, inputSchema: { properties: { cloudId: {}, pageId: {}, contentFormat: { enum: ['adf', 'markdown'] } } } },
  { name: 'getConfluencePageFooterComments', inputSchema: { properties: { cloudId: {}, pageId: {} } } },
  { name: 'getConfluenceSpaces', inputSchema: { properties: { cloudId: {}, limit: {} } } },
  { name: 'createConfluencePage', inputSchema: { properties: { cloudId: {} } } },
  { name: 'updateConfluencePage', annotations: { readOnlyHint: true } },
  { name: 'createConfluenceFooterComment' },
  { name: 'getConfluenceThing', annotations: { readOnlyHint: false } },
  { name: 'getConfluenceDanger', annotations: { destructiveHint: true } },
  { name: 'getJiraIssue', annotations: { readOnlyHint: true } },
  { name: 'searchJiraIssuesUsingJql', annotations: { readOnlyHint: true } },
  { name: 'search', annotations: { readOnlyHint: true } },
];

test('the manifest is valid and its settings check what you type', () => {
  const m = parseManifest(manifest);
  assert.deepEqual(m.doors.map((d) => d.name), ['confluence']);
  assert.ok(validate({ CONFLUENCE_SITE: 'acme.atlassian.net' }).CONFLUENCE_SITE);
  assert.throws(() => validate({ CONFLUENCE_SITE: 'not a site' }), /acme\.atlassian\.net/);
  assert.throws(() => validate({ CONFLUENCE_MCP_URL: 'http://mcp.example.com' }), /https/);
});

test('only read-only Confluence tools are reachable: no writes, no Jira, no general search', () => {
  assert.deepEqual(allowedTools(TOOLS).map((t) => t.name),
    ['getAccessibleAtlassianResources', 'searchConfluenceUsingCql', 'getConfluencePage', 'getConfluencePageFooterComments', 'getConfluenceSpaces']);
});

test('commands pick their tool by name', () => {
  const ok = allowedTools(TOOLS);
  assert.equal(pickTool(ok, 'search').name, 'searchConfluenceUsingCql');
  assert.equal(pickTool(ok, 'read').name, 'getConfluencePage');
  assert.equal(pickTool(ok, 'comments').name, 'getConfluencePageFooterComments');
  assert.equal(pickTool(ok, 'children'), null);
  // Other names, as another server version might call them.
  assert.equal(pickTool([{ name: 'confluence_search' }, { name: 'confluence_get_page' }], 'search').name, 'confluence_search');
});

test('pages by id or link', () => {
  assert.equal(pageId('123456'), '123456');
  assert.equal(pageId('https://acme.atlassian.net/wiki/spaces/DOCS/pages/987654/Release+checklist'), '987654');
  assert.equal(pageId('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=42'), '42');
  assert.equal(pageId('DOCS'), null);
});

test('commands are checked before anything is called', () => {
  assert.deepEqual(parseCommand([]), { cmd: 'help' });
  const s = parseCommand(['search', 'release', 'say "hi"', '--space', 'DOCS', '--limit', '500']);
  assert.equal(s.cql, 'type = page AND text ~ "release say \\"hi\\"" AND space = "DOCS" ORDER BY lastmodified DESC');
  assert.equal(s.limit, 100);
  assert.match(parseCommand(['search', 'x', '--space', 'a b']).error, /space key/);
  assert.equal(parseCommand(['cql', 'space = DOCS']).cql, 'space = DOCS');
  assert.match(parseCommand(['cql', 'a', 'b']).error, /one query/);
  assert.equal(parseCommand(['read', 'https://x.atlassian.net/wiki/spaces/A/pages/77/T']).id, '77');
  assert.match(parseCommand(['read']).error, /one page/);
  assert.deepEqual(parseCommand(['call', 'getConfluenceSpaces', '{"limit":5}']), { cmd: 'call', tool: 'getConfluenceSpaces', args: { limit: 5 } });
  assert.match(parseCommand(['call', 'x', '[1]']).error, /JSON object/);
  assert.match(parseCommand(['call', 'x', '{nope']).error, /not JSON/);
  assert.match(parseCommand(['edit', '1']).error, /unknown command/);
  assert.match(parseCommand(['search', 'x', '--header', 'y']).error, /unknown option/);
});

test('arguments only by the names a tool has', () => {
  const ok = allowedTools(TOOLS);
  assert.deepEqual(argsFor(pickTool(ok, 'read'), { id: '7', cloudId: 'https://acme.atlassian.net', limit: 25 }), { cloudId: 'https://acme.atlassian.net', pageId: '7', contentFormat: 'markdown' });
  assert.deepEqual(argsFor({ inputSchema: { properties: { query: {}, maxResults: {} } } }, { cql: 'x', limit: 3 }), { query: 'x', maxResults: 3 });
});

test('answers as text, cut to a size a chat can take', () => {
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(resultText({ structuredContent: { x: 1 } }), '{\n  "x": 1\n}');
  assert.match(resultText({ content: [{ type: 'text', text: 'x'.repeat(70_000) }] }), /cut: 10000 more characters/);
});

test('site: a setting, or the one the login sees, kept', async () => {
  assert.equal(siteFrom('Acme.atlassian.net/'), 'https://acme.atlassian.net');
  assert.equal(siteFrom('https://acme.atlassian.net/wiki/home'), 'https://acme.atlassian.net');
  assert.equal(siteFrom(''), null);
  const calls = [];
  let kept = null;
  const client = {
    listTools: async () => TOOLS,
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === 'getAccessibleAtlassianResources') return { content: [{ type: 'text', text: JSON.stringify([{ id: 'abc-123', url: 'https://acme.atlassian.net', name: 'acme' }]) }] };
      if (name === 'getConfluencePage') return { content: [{ type: 'text', text: '# Release checklist\n\n1. Tag it' }] };
      if (name === 'getConfluenceSpaces') return { isError: true, content: [{ type: 'text', text: 'Unauthorized' }] };
      return { content: [{ type: 'text', text: 'hits' }] };
    },
  };
  const c = createConfluence({ client, site: () => kept, keepSite: (s) => { kept = s; } });
  assert.match(await c.run(parseCommand(['read', '5'])), /Release checklist/);
  assert.equal(kept, 'https://acme.atlassian.net');
  assert.equal(await c.run(parseCommand(['search', 'tag'])), 'hits');
  assert.equal(calls.filter(([n]) => n === 'getAccessibleAtlassianResources').length, 1, 'asked once');
  assert.deepEqual(calls.at(-1), ['searchConfluenceUsingCql', { cloudId: 'https://acme.atlassian.net', cql: 'type = page AND text ~ "tag" ORDER BY lastmodified DESC', limit: 25 }]);
  await assert.rejects(c.run(parseCommand(['spaces'])), /Confluence said: Unauthorized/);
  await assert.rejects(c.run(parseCommand(['call', 'createConfluencePage', '{}'])), /not one of the read-only/);
  await assert.rejects(c.run(parseCommand(['call', 'getJiraIssue', '{}'])), /not one of the read-only/);
  await assert.rejects(c.run(parseCommand(['children', '5'])), /no read-only tool to children/);
  assert.match(await c.run(parseCommand(['tools'])), /^getAccessibleAtlassianResources[\s\S]*searchConfluenceUsingCql  Search with CQL\n/);
  assert.ok(calls.every(([n]) => !/create|update|Jira/.test(n)), 'never a write or Jira');
});
