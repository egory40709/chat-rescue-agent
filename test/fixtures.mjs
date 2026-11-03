import { chromium } from 'playwright';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExportSession } from '../lib/session.mjs';

// Test-only dependency injection. Production entry points never enable this factory.
export function fixtureSession(root, transport = 'mcp', waitMs = 10) {
  return new ExportSession({ profileRoot: join(root, 'profiles'), controlTransport: transport, defaultConnection: 'isolated',
    engineOptions: { waitMs, delayMs: 0 },
    launch: async ({ profile, provider }) => {
      const context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true });
      await context.setOffline(true);
      await context.route('**/*', async route => {
        const url = route.request().url();
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ url }) + '\n');
        const id = new URL(url).pathname.split('/').pop();
        const prefix = provider === 'chatgpt' ? '/c/' : '/chat/';
        const nav = '<aside><a href="' + prefix + 'one">Первый</a><a href="' + prefix + 'two">Второй</a></aside>';
        const chat = new URL(url).pathname.includes(prefix);
        const user = provider === 'chatgpt' ? 'data-message-author-role="user" data-message-id="u"' : 'data-testid="user-message"';
        const assistant = provider === 'chatgpt' ? 'data-message-author-role="assistant" data-message-id="a"' : 'class="font-claude-response"';
        const html = '<!doctype html><meta charset="utf-8"><title>Test chat</title>' + nav
          + '<main>' + (chat ? '<div ' + user + '>PRIVATE_FIXTURE_QUESTION_' + id + '</div><div ' + assistant + '><p>PRIVATE_FIXTURE_ANSWER_' + id + '</p><pre><code>const value = 42;\n</code></pre></div>' : 'History') + '</main>';
        await route.fulfill({ status: id === 'blocked' ? 403 : 200, contentType: 'text/html; charset=utf-8', body: id === 'blocked' ? '<main>Denied</main>' : html });
      });
      return context;
    },
  });
}
