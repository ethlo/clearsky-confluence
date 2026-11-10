# Confluence for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. Add it with `clearsky add confluence --trust` (or Add under Settings → Plugins): that's `github:ethlo/clearsky-confluence` at the version Clearsky's catalog pins. It needs `--trust` because it lends chats a door with your login, so it runs inside Clearsky.

Lets Copilot chats search and read Confluence with `confluence search "release checklist"` and `confluence read 123456` (or a page link). It goes through Atlassian's remote MCP server (`https://mcp.atlassian.com/v2/mcp`) with your own login, and needs no API token: log in with your browser under Settings → Plugins → Confluence. The login is kept in `~/.config/clearsky/confluence-mcp.json` and never goes in a chat's sandbox.

Read only by construction: of the tools the server offers, a chat can reach only the ones about Confluence that are read only (the server marks them, and none with a write word like create, update or comment in its name). Jira tools on the same server are left out; Clearsky reads Jira through `acli`.

Commands, also shown by `confluence help`:

```
confluence search WORDS [--space KEY] [--limit 25]
confluence cql 'type = page AND space = "DOCS" AND title ~ "runbook"'
confluence read PAGE          (its id or its link)
confluence children PAGE
confluence comments PAGE
confluence spaces
confluence tools              the read-only Confluence tools the server offers
confluence call TOOL '{"json":"arguments"}'
```

When your login sees more than one Atlassian site, set **Confluence site** (like `acme.atlassian.net`). Your organization's admin may need to allow the Rovo MCP server before the login works.

A team pack can set the site, server and scopes for everyone (`CONFLUENCE_SITE`, `CONFLUENCE_MCP_URL`, `CONFLUENCE_MCP_SCOPES`). The site is only needed when a login sees more than one.

## Develop

```sh
git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
CLEARSKY_CORE=.clearsky npm test
```

The tests load the plugin the way Clearsky does, so they need a Clearsky checkout (see `test/core.mjs`). Release by bumping `version` in `clearsky-plugin.json` and `package.json` and tagging `v<version>`.
