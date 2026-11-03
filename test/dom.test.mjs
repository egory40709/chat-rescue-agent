import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureChat, mergeWindow } from '../lib/engine.mjs';
import { readPage } from '../lib/dom.mjs';
import { NativeMacPage } from '../lib/existing-browser.mjs';
import { verifyZip } from '../lib/verification.mjs';

const exec = promisify(execFile), origin = 'https://chatgpt.com', image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let root, context, source, endpoint, sourceTab;
function turn(role, id, body, contents = false) {
  const identity = role === 'user' ? 'data-user-message-bubble data-chatgpt-search-message-ids=\'' + JSON.stringify([id]) + '\'' : 'data-chatgpt-selection-message-id="' + id + '"';
  return '<div' + (contents ? ' style="display:contents"' : '') + '><h4 data-conversation-role="' + role + '">' + (role === 'user' ? 'You said:' : 'ChatGPT said:') + '</h4><div ' + identity + '>' + body + '</div><button>Share</button></div>';
}
const answer = '<div data-markdown-text-style><p>First block</p></div><div data-markdown-text-style><p>Second block</p><div data-code-block><button>Copy code</button><div data-code-block-source>const value = 42;</div></div></div><span style="display:none">HIDDEN_TEXT</span><div role="toolbar">TOOLBAR_LABEL</div>';
const modern = '<!doctype html><main><div style="height:160px;overflow-y:auto">' + turn('user', 'u', 'Question', true) + turn('assistant', 'a', answer) + '</div></main>';
const legacy = '<!doctype html><main><div data-message-author-role="user" data-message-id="u">Question</div><div data-message-author-role="assistant" data-message-id="a"><div class="markdown"><p>First block</p><p>Second block</p><pre><code>const value = 42;</code></pre><button>Copy code</button><span style="display:none">HIDDEN_TEXT</span></div></div></main>';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-dom-')); const profile = join(root, 'browser');
  context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  await context.setOffline(true);
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: modern }));
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); endpoint = 'http://127.0.0.1:' + port;
  source = await context.newPage(); await source.goto(origin + '/c/source');
  const cdp = await context.newCDPSession(source); sourceTab = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
});
after(async () => { await context?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function pageWith(html, id = 'fixture') {
  const page = await context.newPage(); await page.goto(origin + '/c/' + id); await page.setContent(html); return page;
}
const options = { waitMs: 5, readinessMs: 500, maxScrolls: 30, navigate: false };

for (const [name, html] of [['legacy', legacy], ['role headings with display contents', modern]]) test('ChatGPT ' + name + ' preserves both roles, blocks and code while removing controls from both text formats', async () => {
  const page = await pageWith(html);
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'fixture', url: page.url() }, options);
    assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(chat.messages.map(message => message.domId), ['u', 'a']);
    assert.equal(chat.messages[0].markdown, 'Question'); assert.equal(chat.messages[0].text, 'Question');
    assert.match(chat.messages[1].markdown, /First block/); assert.match(chat.messages[1].markdown, /Second block/);
    assert.match(chat.messages[1].markdown, /```\nconst value = 42;\n```/);
    for (const field of ['markdown', 'text']) assert.doesNotMatch(chat.messages[1][field], /ChatGPT said|Share|Copy code|HIDDEN_TEXT|TOOLBAR_LABEL/);
    assert.deepEqual(chat.warnings, []); assert.equal(chat.fallbackText, null);
    const meta = await page.evaluate(readPage, { provider: 'chatgpt', metadataOnly: true });
    assert.equal(meta.messages, 2); assert.doesNotMatch(JSON.stringify(meta), /Question|First block/);
    if (name.startsWith('role')) assert.equal(await page.evaluate(() => document.querySelector('[data-user-message-bubble]').parentElement.getClientRects().length), 0);
  } finally { await page.close(); }
});
test('mixed layouts retain document order and hidden legacy nodes never suppress role headings', async () => {
  const html = '<main><div data-message-author-role="user" style="display:none">HIDDEN_LEGACY</div>' + turn('user', 'u', 'First question', true) + turn('assistant', 'a', 'First answer')
    + '<div data-message-author-role="user" data-message-id="u2">Second question</div><div data-message-author-role="assistant" data-message-id="a2">Second answer</div></main>';
  const page = await pageWith(html);
  try {
    const state = await page.evaluate(readPage, { provider: 'chatgpt' });
    assert.deepEqual(state.messages.map(message => message.domId), ['u', 'a', 'u2', 'a2']);
    assert.deepEqual(state.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.doesNotMatch(JSON.stringify(state.messages), /HIDDEN_LEGACY/);
  } finally { await page.close(); }
});
test('multi-ID and conflicting heading metadata never become a guessed stable message identity', async () => {
  const page = await pageWith(modern);
  try {
    await page.evaluate(() => document.querySelector('[data-chatgpt-search-message-ids]').setAttribute('data-chatgpt-search-message-ids', '["u","other"]'));
    assert.equal((await page.evaluate(readPage, { provider: 'chatgpt' })).messages[0].domId, null);
    await page.evaluate(() => { const heading = document.createElement('h4'); heading.setAttribute('data-conversation-role', 'assistant'); document.querySelector('[data-user-message-bubble]').parentElement.appendChild(heading); });
    const state = await page.evaluate(readPage, { provider: 'chatgpt' });
    assert.ok(!state.messages.some(message => message.text === 'Question'));
  } finally { await page.close(); }
});
test('rendered media addresses are metadata and code containing triple backticks uses a longer fence', async () => {
  const code = 'const literal = "```";';
  const page = await pageWith('<main>' + turn('user', 'u', 'Question', true) + turn('assistant', 'a', '<div data-code-block><button>Copy</button><div data-code-block-source>' + code + '</div></div><img width="16" height="16" src="' + image + '" alt="Fixture image">') + '</main>');
  try {
    const state = await page.evaluate(readPage, { provider: 'chatgpt' });
    assert.match(state.messages[1].markdown, /````\nconst literal = "```";\n````/);
    assert.deepEqual(state.messages[1].media, [{ kind: 'img', url: image, alt: 'Fixture image' }]); assert.equal(state.mediaCount, 1);
  } finally { await page.close(); }
});
test('native macOS serialises the heading reader in the working tab without relying on Node closures', async () => {
  const work = await pageWith(modern);
  const page = new NativeMacPage({ app: 'Google Chrome', provider: 'chatgpt', reference: { windowId: 7, tabId: '8' }, bridge: async input => {
    if (input.action === 'info') return { url: work.url(), loading: false };
    if (input.action === 'execute') return JSON.parse(await work.evaluate(input.script));
    if (input.action === 'close') await work.close();
  } });
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'fixture', url: work.url() }, options);
    assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant']); assert.deepEqual(chat.warnings, []);
  } finally { await page.close(); }
});
const message = (domId, markdown, extra = {}) => ({ domId, role: 'assistant', markdown, text: markdown, ...extra });
test('stable IDs preserve later references and longer prefixes without duplicating or mutating saved messages', () => {
  const a = message('a', 'First block'), b = message('b', 'Second block');
  const original = JSON.stringify([a, b]);
  const merged = mergeWindow([a, b], [message('a', 'First block plus loaded source'), b]);
  assert.equal(merged.gap, false); assert.equal(merged.messages.length, 2); assert.match(merged.messages[0].markdown, /loaded source/);
  assert.deepEqual(mergeWindow(merged.messages, [a, b]).messages, merged.messages);
  const linked = mergeWindow([a], [message('a', 'First block (https://example.test/source)', { text: 'First block' })]);
  assert.match(linked.messages[0].markdown, /example\.test/); assert.equal(linked.conflicts, undefined);
  assert.equal(JSON.stringify([a, b]), original);
});
test('different bodies under one ID are flagged instead of choosing a longer contradictory answer', () => {
  const first = message('a', 'The user accepted.');
  const merged = mergeWindow([first], [message('a', 'The user refused this request, with a much longer reason.')]);
  assert.equal(merged.messages.length, 1); assert.equal(merged.messages[0].text, first.text); assert.equal(merged.conflicts, true);
  const gap = mergeWindow([message('a', 'A'), message('b', 'B')], [message('a', 'A'), message('c', 'C')]);
  assert.equal(gap.gap, true); assert.deepEqual(gap.messages.map(item => item.domId), ['a', 'b', 'c']);
});
for (const conflict of [false, true]) test('virtualised heading windows ' + (conflict ? 'retain conflicting snapshots with a warning' : 'merge late links by ID with no duplicated turns'), async () => {
  const initial = '<main>' + turn('user', 'u', 'Question', true) + turn('assistant', 'a', '<a href="https://example.test/a">Source</a>') + '</main>';
  const updated = '<main>' + turn('assistant', 'a', conflict ? 'A different answer with more characters.' : '<a href="https://example.test/expanded-source">Source</a>') + turn('user', 'u2', 'Next question', true) + turn('assistant', 'a2', 'Next answer') + '</main>';
  const work = await pageWith(initial); let changed = false;
  const adapter = { on: (...args) => work.on(...args), off: (...args) => work.off(...args), url: () => work.url(), isClosed: () => work.isClosed(),
    evaluate: async (fn, args) => { if (args?.action === 'down' && !changed) { changed = true; await work.setContent(updated); } return work.evaluate(fn, args); } };
  try {
    const chat = await captureChat(adapter, 'chatgpt', { id: 'fixture', url: work.url() }, options);
    assert.deepEqual(chat.messages.map(item => item.domId), ['u', 'a', 'u2', 'a2']);
    assert.equal(chat.diagnostics.has_gap, false); assert.equal(chat.diagnostics.has_conflicting_bodies, conflict);
    if (conflict) { assert.ok(chat.warnings.some(warning => warning.includes('одним ID'))); assert.match(JSON.stringify(chat.snapshots), /different answer/); }
    else { assert.deepEqual(chat.warnings, []); assert.match(chat.messages[1].markdown, /expanded-source/); }
  } finally { await work.close(); }
});
test('an assistant-only DOM transcript has an explicit completeness warning', async () => {
  const page = await pageWith('<main>' + turn('assistant', 'a', 'Answer without a recognised question') + '</main>');
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'fixture', url: page.url() }, options);
    assert.deepEqual(chat.diagnostics.message_roles, ['assistant']); assert.ok(chat.warnings.some(warning => warning.includes('обе роли')));
  } finally { await page.close(); }
});
async function checkArchive(status) {
  assert.equal(status.phase, 'complete', JSON.stringify(status)); assert.deepEqual(status.counts, { saved: 1, partial: 0, failed: 0, pending: 0 });
  assert.equal((await verifyZip(status.out, status.zip)).verified, true);
  const manifest = JSON.parse(await readFile(status.manifest_file, 'utf8')), entry = Object.values(manifest.chats)[0];
  const chat = JSON.parse(await readFile(join(status.out, entry.jsonFile), 'utf8'));
  assert.deepEqual(chat.messages.map(item => item.role), ['user', 'assistant']); assert.equal(chat.method, 'rendered-ui-v1');
  assert.deepEqual(chat.messages.map(item => item.domId), ['u', 'a']);
  assert.equal(chat.messages[0].text, 'Question'); assert.match(chat.messages[1].markdown, /const value = 42/); assert.deepEqual(chat.warnings, []);
  const markdown = await readFile(join(status.out, entry.markdownFile), 'utf8');
  assert.match(markdown, /Question/); assert.match(markdown, /const value = 42/); assert.doesNotMatch(markdown, /Share|Copy code|HIDDEN_TEXT|TOOLBAR_LABEL|ChatGPT said/);
  await exec(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import zipfile,json,hashlib,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read("manifest.json")); e=list(m["chats"].values())[0]; c=json.loads(z.read(e["jsonFile"])); assert [v["role"] for v in c["messages"]]==["user","assistant"]; assert hashlib.sha256(z.read(e["jsonFile"])).hexdigest()==e["jsonSha256"]; assert hashlib.sha256(z.read(e["markdownFile"])).hexdigest()==e["markdownSha256"]', status.zip.path]);
}
test('production CLI exports the reported role-heading layout including the user display-contents wrapper', async () => {
  const script = resolve(import.meta.dirname, '../agent.mjs'); let result;
  try {
    result = JSON.parse((await exec(process.execPath, [script, 'scrape', '--provider', 'chatgpt', '--workspace', 'heading-cli', '--out', join(root, 'cli'), '--cdp', endpoint, '--source-tab', sourceTab, '--mode', 'current'])).stdout);
    assert.equal(result.export_succeeded, true); await checkArchive(result);
  } finally { if (result?.run_file) await exec(process.execPath, [script, 'close', '--run', result.run_file]); }
  assert.equal(source.isClosed(), false);
});
test('production MCP exports the same heading layout and completes its checked archive', async () => {
  const client = new Client({ name: 'role-heading-test', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '../mcp.mjs')], stderr: 'pipe' });
  let sessionId;
  try {
    await client.connect(transport);
    const opened = await client.callTool({ name: 'open_export_session', arguments: { provider: 'chatgpt', workspace: 'heading-mcp', out: join(root, 'mcp'), cdp_endpoint: endpoint, source_tab: sourceTab, initial_options: { mode: 'current' } } });
    assert.ok(!opened.isError, opened.content?.[0]?.text); sessionId = opened.structuredContent.session_id;
    const started = Date.now(); let status;
    do { status = (await client.callTool({ name: 'get_export_status', arguments: { session_id: sessionId } })).structuredContent; if (['complete', 'needs_review', 'failed', 'blocked'].includes(status.phase)) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() - started < 30000);
    await checkArchive(status);
  } finally { if (sessionId) await client.callTool({ name: 'close_export_session', arguments: { session_id: sessionId } }); await client.close(); }
  assert.equal(source.isClosed(), false);
});
