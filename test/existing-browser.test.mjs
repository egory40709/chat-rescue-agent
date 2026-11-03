import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ExportSession } from '../lib/session.mjs';
import { localCdpEndpoint, chooseSource, attachNativeMac, BrowserConnectionError, JXA_SOURCE, discoverCdpEndpoints } from '../lib/existing-browser.mjs';

const exec = promisify(execFile);
let root, context, source, endpoint, wsEndpoint;
const requests = [];
const terminal = value => ['complete', 'needs_review', 'paused', 'blocked', 'failed'].includes(value.phase);
async function waitFor(fn, predicate, timeout = 15000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    last = await fn(); if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out: ' + JSON.stringify(last));
}
function fixtureHtml(id, loggedIn, needsLogin = false) {
  if (!loggedIn || needsLogin) return '<!doctype html><meta charset="utf-8"><dialog open role="dialog" aria-modal="true">Войти на chatgpt.com <button>Продолжить с помощью Google</button></dialog>';
  if (id.startsWith('team-')) return '<!doctype html><meta charset="utf-8"><title>Team fixture without native export</title>'
    + '<header>Business workspace</header><aside id="history" style="height:70px;overflow-y:auto">'
    + '<a href="/c/team-one">Первый рабочий чат</a><div style="height:350px"></div></aside>'
    + '<main><article data-message-author-role="user" data-message-id="u">TEAM_QUESTION_' + id + '</article>'
    + '<article data-message-author-role="assistant" data-message-id="a"><p>TEAM_ANSWER_' + id + '</p>'
    + '<pre><code>const teamArchive = true;</code></pre></article></main>'
    + '<script>const historyList=document.getElementById("history");historyList.addEventListener("scroll",()=>{'
    + 'if(historyList.scrollTop>10&&!document.getElementById("older-chat"))'
    + 'historyList.insertAdjacentHTML("beforeend",\'<a id="older-chat" href="/c/team-two">Второй рабочий чат</a>\');});</script>';
  return '<!doctype html><meta charset="utf-8"><title>Existing login fixture</title><aside><a href="/c/one">Один</a><a href="/c/two">Два</a></aside><main>'
    + '<article data-message-author-role="user" data-message-id="u">EXISTING_PRIVATE_QUESTION_' + id + '</article>'
    + '<article data-message-author-role="assistant" data-message-id="a"><p>EXISTING_PRIVATE_ANSWER_' + id + '</p></article></main>';
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-existing-'));
  const profile = join(root, 'browser-profile');
  context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  await context.setOffline(true);
  // Only test code handles its artificial cookie; production attachment never reads cookies.
  await context.addCookies([{ name: 'fixture-login', value: 'already-signed-in', domain: 'chatgpt.com', path: '/', httpOnly: true, secure: true }]);
  await context.route('https://chatgpt.com/**', async route => {
    const url = route.request().url();
    const headers = await route.request().allHeaders();
    const signedIn = (headers.cookie || '').includes('fixture-login=already-signed-in');
    requests.push({ url, signedIn, method: route.request().method(), navigation: route.request().isNavigationRequest() });
    const id = new URL(url).pathname.split('/').pop();
    const body = id === 'slow' && signedIn ? '<!doctype html><meta charset="utf-8"><main>Loading</main><script>setTimeout(()=>{document.body.innerHTML='
      + JSON.stringify(fixtureHtml(id, true)) + '},350)</script>' : fixtureHtml(id, signedIn, id === 'needs-login');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  const [port, wsPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  endpoint = 'http://127.0.0.1:' + port;
  wsEndpoint = 'ws://127.0.0.1:' + port + wsPath;
  source = await context.newPage(); await source.goto('https://chatgpt.com/c/source');
});
after(async () => { await context?.close(); if (root) await rm(root, { recursive: true, force: true }); });
function session(options = {}) {
  return new ExportSession({ engineOptions: { waitMs: 10, delayMs: 0 },
    launch: async () => { throw new Error('An isolated browser must never be launched'); }, ...options });
}

test('CDP only accepts literal local endpoints without credentials or redirects', () => {
  assert.equal(localCdpEndpoint('http://localhost:9222'), 'http://127.0.0.1:9222/');
  for (const value of ['https://127.0.0.1:9222', 'http://evil.example:9222', 'http://127.0.0.1:9222/path',
    'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222/?token=secret']) assert.throws(() => localCdpEndpoint(value), /локальн/);
  assert.throws(() => localCdpEndpoint('ws://evil.example:9222/devtools/browser/x', true), /локальн/);
});
test('tab selection prefers a focused tab and never guesses between accounts', () => {
  const candidates = [{ id: 'a', url: 'https://chatgpt.com/c/a?token=hidden', focused: false }, { id: 'b', url: 'https://chatgpt.com/c/b', focused: true }];
  assert.equal(chooseSource(candidates).id, 'b');
  assert.equal(chooseSource(candidates, 'a').id, 'a');
  candidates[1].focused = false;
  assert.throws(() => chooseSource(candidates), error => error.code === 'source_tab_required' && !JSON.stringify(error.details).includes('hidden'));
  assert.throws(() => chooseSource(candidates, 'missing'), error => error.code === 'source_tab_not_found');
});
test('auto-discovery reads debugging-port metadata without opening a profile database', async () => {
  const home = join(root, 'discovery');
  const profile = join(home, '.config/google-chrome'); await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/test\n');
  const endpoints = await discoverCdpEndpoints({ platform: 'linux', home });
  assert.deepEqual(endpoints, ['ws://127.0.0.1:12345/devtools/browser/test', 'http://127.0.0.1:9222/']);
  assert.deepEqual(await readdir(profile), ['DevToolsActivePort']);
});
test('existing session exports immediately and inherits login without another sign-in', async () => {
  const before = context.pages().length;
  const originalUrl = source.url();
  const exporter = session();
  try {
    const opened = await exporter.open({ provider: 'chatgpt', workspace: 'existing-auto', out: join(root, 'existing-auto'), cdp_endpoint: endpoint });
    assert.notEqual(opened.phase, 'awaiting_login'); assert.ok(opened.job_id);
    assert.equal(opened.connection, 'existing');
    assert.equal(context.pages().length, before + 1);
    const done = await waitFor(() => exporter.status(), terminal);
    assert.equal(done.phase, 'complete', JSON.stringify(done)); assert.equal(done.counts.saved, 2);
    assert.equal(source.url(), originalUrl);
    assert.ok(requests.every(request => request.signedIn));
    assert.ok(!requests.some(request => /\/(auth|login|signin)/.test(new URL(request.url).pathname)));
    const bytes = await readFile(done.zip.path); assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  } finally { await exporter.close(); }
  assert.equal(source.isClosed(), false);
  assert.equal(context.browser().isConnected(), true);
  assert.equal(context.pages().length, before);
  assert.match(await source.locator('main').innerText(), /EXISTING_PRIVATE_ANSWER_source/);
});
test('Team without Export data: discovers lazy history and saves each conversation directly', async () => {
  const teamSource = await context.newPage(); await teamSource.goto('https://chatgpt.com/c/team-source');
  assert.equal(await teamSource.getByRole('button', { name: /export data|экспорт данных/i }).count(), 0);
  const cdp = await context.newCDPSession(teamSource);
  const sourceTab = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
  const from = requests.length;
  const exporter = session();
  try {
    const opened = await exporter.open({ provider: 'chatgpt', workspace: 'team-no-native-export',
      out: join(root, 'team-no-native-export'), cdp_endpoint: endpoint, source_tab: sourceTab });
    assert.ok(opened.job_id);
    const done = await waitFor(() => exporter.status(), terminal);
    assert.equal(done.phase, 'complete', JSON.stringify(done));
    assert.equal(done.counts.saved, 2); assert.equal(done.last_discovery.observed_links, 2);
    assert.equal(done.extraction_method, 'ui-conversation-v2'); assert.equal(done.native_export_required, false);
    const manifest = JSON.parse(await readFile(done.manifest_file, 'utf8'));
    assert.deepEqual(Object.keys(manifest.chats).sort(), ['team-one', 'team-two']);
    for (const [id, chat] of Object.entries(manifest.chats)) {
      const saved = JSON.parse(await readFile(join(done.out, chat.jsonFile), 'utf8'));
      assert.equal(saved.method, 'rendered-ui-v1');
      assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant']);
      assert.match(saved.messages[1].text, new RegExp('TEAM_ANSWER_' + id));
      const markdown = await readFile(join(done.out, chat.markdownFile), 'utf8');
      assert.match(markdown, new RegExp('TEAM_QUESTION_' + id)); assert.match(markdown, /const teamArchive = true;/);
    }
    const navigations = requests.slice(from).filter(request => request.navigation);
    assert.deepEqual(navigations.map(request => new URL(request.url).pathname), ['/c/team-source', '/c/team-one', '/c/team-two']);
    assert.ok(navigations.every(request => request.method === 'GET' && request.signedIn));
    const zip = await readFile(done.zip.path); assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(teamSource.url(), 'https://chatgpt.com/c/team-source');
    assert.doesNotMatch(JSON.stringify(done), /TEAM_(QUESTION|ANSWER)_/);
  } finally { await exporter.close(); await teamSource.close(); }
  assert.equal(context.browser().isConnected(), true);
});
test('missing provider tabs do not create an isolated browser or a login window', async () => {
  const before = context.pages().length;
  const exporter = session();
  await assert.rejects(exporter.open({ provider: 'claude', workspace: 'missing', out: join(root, 'missing'), cdp_endpoint: endpoint }), error => error.code === 'no_source_tab');
  assert.equal(context.pages().length, before);
  assert.equal(context.browser().isConnected(), true);
  const run = JSON.parse(await readFile(join(root, 'missing/run.json'), 'utf8'));
  assert.equal(run.error_code, 'no_source_tab');
});
test('slow client rendering is awaited instead of being mistaken for a missing login', async () => {
  const slow = await context.newPage(); await slow.goto('https://chatgpt.com/c/slow');
  const cdp = await context.newCDPSession(slow);
  const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
  const exporter = session();
  try {
    const opened = await exporter.open({ provider: 'chatgpt', workspace: 'slow', out: join(root, 'slow'),
      cdp_endpoint: endpoint, source_tab: id, initial_options: { mode: 'current' } });
    assert.ok(opened.job_id);
    const result = await waitFor(() => exporter.status(), terminal);
    assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 1);
  } finally { await exporter.close(); await slow.close(); }
});
test('an attached existing session starts without user_ready or another confirmation', async () => {
  const exporter = session();
  try {
    const opened = await exporter.open({ provider: 'chatgpt', workspace: 'no-confirmation', out: join(root, 'no-confirmation'), cdp_endpoint: endpoint, auto_start: false });
    assert.equal(opened.phase, 'ready'); assert.equal(opened.job_id, null);
    const started = await exporter.start({ mode: 'current' });
    assert.ok(started.job_id);
    const done = await waitFor(() => exporter.status(), terminal);
    assert.equal(done.phase, 'complete'); assert.equal(done.counts.saved, 1);
  } finally { await exporter.close(); }
});
test('a sign-in modal is reported and never becomes a successful transcript', async () => {
  const loginSource = await context.newPage(); await loginSource.goto('https://chatgpt.com/c/needs-login');
  const cdp = await context.newCDPSession(loginSource);
  const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
  const before = context.pages().length;
  const exporter = session();
  await assert.rejects(exporter.open({ provider: 'chatgpt', workspace: 'modal', out: join(root, 'modal'), cdp_endpoint: endpoint, source_tab: id }), error => error.code === 'source_auth_required');
  assert.equal(context.pages().length, before);
  assert.deepEqual(await readdir(join(root, 'modal/chats')), []);
  assert.equal(loginSource.isClosed(), false); await loginSource.close();
});
test('closing an active export detaches the tool and leaves the original browser open', async () => {
  const exporter = session({ engineOptions: { waitMs: 30, delayMs: 0 } });
  const before = context.pages().length;
  await exporter.open({ provider: 'chatgpt', workspace: 'detach', out: join(root, 'detach'), cdp_endpoint: endpoint,
    initial_options: { mode: 'urls', urls: Array.from({ length: 10 }, (_, i) => 'https://chatgpt.com/c/detach-' + i) } });
  const closed = await exporter.close();
  assert.equal(closed.detached, true); assert.equal(closed.browser_closed, false);
  assert.equal(closed.phase, 'paused');
  assert.equal(source.isClosed(), false); assert.equal(context.pages().length, before);
});
test('MCP open_export_session alone attaches and completes export without a continue call', async () => {
  const fixtureRoot = join(root, 'mcp'); await mkdir(fixtureRoot);
  const client = new Client({ name: 'existing-mcp-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, 'fixture-server.mjs')],
    env: { ...process.env, FIXTURE_ROOT: fixtureRoot }, stderr: 'pipe' });
  let id;
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'open_export_session', arguments: {
      provider: 'chatgpt', workspace: 'mcp-existing', out: join(root, 'mcp-existing'), connection: 'existing', cdp_endpoint: wsEndpoint,
    } });
    assert.ok(!result.isError, result.content?.[0]?.text); id = result.structuredContent.session_id;
    assert.ok(result.structuredContent.job_id);
    const done = await waitFor(async () => (await client.callTool({ name: 'get_export_status', arguments: { session_id: id } })).structuredContent, terminal);
    assert.equal(done.phase, 'complete'); assert.equal(done.counts.saved, 2);
    assert.doesNotMatch(JSON.stringify(done), /EXISTING_PRIVATE_/);
    const closed = await client.callTool({ name: 'close_export_session', arguments: { session_id: id } });
    assert.equal(closed.structuredContent.detached, true); id = null;
    assert.equal(source.isClosed(), false);
  } finally {
    if (id) await client.callTool({ name: 'close_export_session', arguments: { session_id: id } }).catch(() => {});
    await client.close();
  }
});
test('production CLI scrape waits for a verified archive in the existing session without continue', async () => {
  const script = resolve(import.meta.dirname, '../agent.mjs');
  const started = JSON.parse((await exec(process.execPath, [script, 'scrape', '--provider', 'chatgpt', '--workspace', 'cli-existing',
    '--out', join(root, 'cli-existing'), '--cdp', endpoint, '--mode', 'current'])).stdout);
  try {
    assert.equal(started.export_finished, true); assert.equal(started.export_succeeded, true);
    assert.equal(started.archive_verification.verified, true);
    const done = await waitFor(async () => JSON.parse((await exec(process.execPath, [script, 'status', '--run', started.run_file])).stdout), terminal, 30000);
    assert.equal(done.phase, 'complete', JSON.stringify(done));
    assert.equal(done.counts.saved, 1); assert.equal(done.connection, 'existing');
    assert.ok(done.zip.path.endsWith('.zip'));
    assert.notEqual(done.phase, 'awaiting_login');
  } finally {
    const closed = JSON.parse((await exec(process.execPath, [script, 'close', '--run', started.run_file])).stdout);
    assert.equal(closed.detached, true); assert.equal(closed.browser_closed, false);
  }
  assert.equal(source.isClosed(), false); assert.equal(context.browser().isConnected(), true);
});
test('native macOS automation checks permission before creating any tab', async () => {
  const actions = [];
  await assert.rejects(attachNativeMac({ provider: 'chatgpt', bridge: async input => {
    actions.push(input.action);
    if (input.action === 'list') return { tabs: [{ id: '1:2', windowId: 1, tabId: '2', url: 'https://chatgpt.com/c/source', focused: true }] };
    throw new BrowserConnectionError('browser_automation_permission', 'Permission not enabled');
  } }), error => error.code === 'browser_automation_permission');
  assert.deepEqual(actions, ['list', 'execute']);
});
test('native macOS bridge retains the selected window, validates URLs and closes only its tab', async () => {
  let work = null; const actions = [];
  const attached = await attachNativeMac({ provider: 'chatgpt', bridge: async input => {
    actions.push(input.action);
    if (input.action === 'list') return { tabs: [{ id: '7:8', windowId: 7, tabId: '8', url: source.url(), focused: true }] };
    if (input.action === 'execute' && !work) return { available: true };
    if (input.action === 'create') {
      assert.equal(input.windowId, 7); work = await context.newPage(); await work.goto(input.url);
      return { windowId: 7, tabId: '9' };
    }
    assert.equal(input.windowId, 7); assert.equal(input.tabId, '9');
    if (input.action === 'navigate') { await work.goto(input.url); return { ok: true }; }
    if (input.action === 'info') return { url: work.url(), loading: false };
    if (input.action === 'execute') return JSON.parse(await work.evaluate(input.script));
    if (input.action === 'close') { await work.close(); return { ok: true }; }
    throw new Error('Unexpected native action');
  } });
  try {
    assert.equal(await attached.pages()[0].evaluate(() => document.querySelectorAll('[data-message-author-role]').length), 2);
    await assert.rejects(attached.pages()[0].goto('https://evil.example/'), /внутри выбранного/);
  } finally { await attached.close(); }
  assert.equal(work.isClosed(), true); assert.equal(source.isClosed(), false);
  assert.equal(actions.at(-1), 'close');
});
test('native Apple Events source compiles on macOS without contacting a user browser', { skip: process.platform !== 'darwin' }, async () => {
  const path = join(root, 'bridge.js'); await writeFile(path, JXA_SOURCE);
  await exec('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', join(root, 'bridge.scpt'), path]);
});
