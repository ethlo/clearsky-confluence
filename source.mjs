// Confluence through Atlassian's remote MCP server, read only: you log in from Settings in your
// browser (OAuth with PKCE; Clearsky registers itself as a client, so there's no token or app to
// create), and Copilot chats search and read pages with `confluence …`. That runs here with
// your login, which never goes in the sandbox, and reaches only the server's read-only
// Confluence tools (lib/confluence.mjs). What it reaches and keeps is in clearsky-plugin.json.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createConfluenceMcp, parseCommand, USAGE } from './lib/confluence.mjs';

export default (lends, { store, fetchImpl = fetch } = {}) => {
  store ||= lends.mcpOAuth.tokenStore(join(homedir(), '.config', 'clearsky', 'confluence-mcp.json'));
  const c = createConfluenceMcp({ lends, store, fetchImpl });

  return {
    // What's set up, for Settings → Plugins; Confluence itself is only read through the door.
    async fetch(ctx) {
      c.use(ctx.env);
      return { loggedIn: c.status().loggedIn };
    },

    // One login, with a Log out next to it (Settings → Plugins → Confluence).
    logins: {
      list(env) { c.use(env); const s = c.status(); return [{ id: 'atlassian', label: 'Atlassian', ...s, canLogOut: s.loggedIn }]; },
      async start(id, env) { c.use(env); return c.login(); },
      async stop(id, env) { c.use(env); c.logout(); },
    },

    doors: {
      confluence: {
        usage: USAGE,
        hint(env) {
          c.use(env);
          if (!c.status().loggedIn) return '';
          return 'To read our Confluence (find pages, read a page, its children or comments), use `confluence` (`confluence help` lists its commands): it reads as me, read only, through Clearsky, which holds the login. It can\'t change anything in Confluence; write out suggested changes instead.';
        },
        async run(argv, door) {
          c.use(door.env);
          const cmd = parseCommand(argv);
          if (cmd.error) return { code: 2, stdout: '', stderr: `confluence: ${cmd.error}\n\n${USAGE}\n`, decided: 'refused' };
          try { return { code: 0, stdout: `${await c.run(cmd)}\n`, stderr: '', decided: 'read' }; }
          catch (e) {
            const refused = /not one of the read-only/.test(e.message);
            return { code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n`, decided: e.auth ? 'not logged in' : refused ? 'refused' : 'failed' };
          }
        },
      },
    },
  };
};
