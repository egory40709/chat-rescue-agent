import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ExportSession } from '../lib/session.mjs';
import { normalizeOfficial } from '../lib/archive.mjs';
import { verifyProviders } from '../lib/verify-providers.mjs';

const exec = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const services = ['chatgpt', 'claude'];
const origins = { chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai' };
const ids = Array.from({ length: 5 }, (_, i) => '12345678-1234-4234-8234-' + String(i + 1).padStart(12, '0'));
const ambiguousId = '12345678-1234-4234-8234-888888888888';
const deniedId = '12345678-1234-4234-8234-999999999999';
const requests = [];
let root, context, endpoint;
const question = id => 'PRIVATE_PROVIDER_QUESTION_' + id + '\nПривет 👋';
const answer = id => 'PRIVATE_PROVIDER_ANSWER_' + id + '\n\n```js\nconst value = 42;\n```';
function chatPath(service, id) { return (service === 'chatgpt' ? '/c/' : '/chat/') + id; }
function dataPath(service, id) { return service === 'chatgpt' ? '/backend-api/conversation/' + id : '/api/organizations/87654321-1234-4234-8234-123456789012/chat_conversations/' + id + '?tree=true&rendering_mode=messages&render_all_tools=true'; }
function payload(service, id) {
  if (service === 'chatgpt') return { conversation_id: id, title: 'Fixture', current_node: 'a', mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, content: { parts: [question(id)] } } },
    old: { parent: 'u', message: { id: 'old', author: { role: 'assistant' }, content: { parts: ['ABANDONED_BRANCH_MUST_STAY_IN_RAW'] } } },
    a: { parent: 'u', message: { id: 'a', author: { role: 'assistant' }, content: { parts: [answer(id)] } } },
  } };
  return { uuid: id, name: 'Fixture', current_leaf_message_uuid: 'a', chat_messages: [
    { uuid: 'old', parent_message_uuid: 'u', sender: 'assistant', content: [{ type: 'text', text: 'ABANDONED_BRANCH_MUST_STAY_IN_RAW' }] },
    { uuid: 'a', parent_message_uuid: 'u', sender: 'assistant', truncated: false, content: [{ type: 'text', text: answer(id) }] },
    { uuid: 'u', parent_message_uuid: '00000000-0000-0000-0000-000000000000', sender: 'human', content: [{ type: 'text', text: question(id) }] },
  ] };
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-providers-')); const profile = join(root, 'browser');
  context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  await context.setOffline(true);
  for (const service of services) await context.addCookies([{ name: 'fixture-' + service, value: 'signed-in', domain: new URL(origins[service]).hostname, path: '/', secure: true, httpOnly: true }]);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); const service = services.find(name => origins[name] === url.origin);
    if (!service) return route.abort();
    const signedIn = (await route.request().headerValue('cookie') || '').includes('fixture-' + service + '=signed-in');
    const id = url.pathname.split('/').at(-1); const data = /\/backend-api\/|\/api\/organizations\//.test(url.pathname);
    requests.push({ service, id, data, signedIn, method: route.request().method() });
    if (!signedIn) return route.fulfill({ status: 401, contentType: 'text/html', body: '<main>Login required</main>' });
    if (data) { const record = payload(service, id); if (id === ambiguousId) delete record.current_leaf_message_uuid; return route.fulfill({ status: id === deniedId ? 403 : 200, contentType: 'application/json', body: JSON.stringify(record) }); }
    const history = '<aside>' + ids.map(id => '<a href="' + chatPath(service, id) + '">Fixture</a>').join('') + '</aside>';
    // No role selectors: production must capture the actual UI JSON and cannot pass by parsing this shell.
    const transcript = id === ambiguousId ? '<main><div data-testid="user-message">Visible question</div><div class="font-claude-response">Visible answer</div></main>' : '<main>Conversation shell</main>';
    const body = '<!doctype html><meta charset="utf-8">' + history + transcript + '<script>fetch(' + JSON.stringify(dataPath(service, id)) + ').then(r=>r.json())</script>';
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); endpoint = 'http://127.0.0.1:' + port;
  for (const service of services) { const page = await context.newPage(); await page.goto(origins[service] + chatPath(service, ids[0])); }
});
after(async () => { await context?.close(); if (root) await rm(root, { recursive: true, force: true }); });
const terminal = status => ['complete', 'needs_review', 'failed', 'blocked', 'paused'].includes(status.phase);
async function wait(fn, timeout = 30000) { const start = Date.now(); let value; do { value = await fn(); if (terminal(value)) return value; await sleep(30); } while (Date.now() - start < timeout); throw new Error('Timeout: ' + JSON.stringify(value)); }
async function checkArchive(result, service, expected = 5) {
  const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8')); assert.equal(Object.keys(manifest.chats).length, expected);
  for (const [id, entry] of Object.entries(manifest.chats)) {
    const chat = JSON.parse(await readFile(join(result.out, entry.jsonFile), 'utf8'));
    assert.equal(chat.id, id); assert.equal(chat.provider, service); assert.equal(chat.method, 'observed-ui-json-v1');
    assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(chat.messages[0].text, question(id)); assert.equal(chat.messages[1].text, answer(id));
    assert.doesNotMatch(JSON.stringify(chat.messages), /ABANDONED_BRANCH/);
    assert.match(JSON.stringify(chat.raw), /ABANDONED_BRANCH/);
    const markdown = await readFile(join(result.out, entry.markdownFile), 'utf8');
    assert.match(markdown, /Привет 👋/); assert.match(markdown, /const value = 42/); assert.doesNotMatch(markdown, /ABANDONED_BRANCH/);
  }
  await exec(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import zipfile,json,hashlib,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read("manifest.json")); assert len(m["chats"])==int(sys.argv[2]); assert all(hashlib.sha256(z.read(e["jsonFile"])).hexdigest()==e["jsonSha256"] and hashlib.sha256(z.read(e["markdownFile"])).hexdigest()==e["markdownSha256"] for e in m["chats"].values())', result.zip.path, String(expected)]);
}

for (const service of services) test('production CLI fully exports five ' + service + ' chats, checks ZIP and resumes without rereading saved chats', async () => {
  const script = resolve(import.meta.dirname, '../agent.mjs'); const out = join(root, 'cli-' + service);
  const args = [script, 'scrape', '--provider', service, '--workspace', 'test', '--out', out, '--cdp', endpoint, '--delay-ms', '1000', '--list-scrolls', '10'];
  let result;
  try {
    const stdout = (await exec(process.execPath, args)).stdout; result = JSON.parse(stdout);
    assert.equal(result.phase, 'complete', stdout); assert.equal(result.export_succeeded, true); assert.equal(result.counts.saved, 5);
    assert.deepEqual(result.counts, { pending: 0, saved: 5, partial: 0, failed: 0 });
    assert.doesNotMatch(stdout, /PRIVATE_PROVIDER_/); await checkArchive(result, service);
    const before = requests.filter(request => request.service === service && request.data).length;
    const repeated = JSON.parse((await exec(process.execPath, args)).stdout);
    assert.equal(repeated.export_succeeded, true); assert.equal(repeated.counts.saved, 5);
    assert.equal(requests.filter(request => request.service === service && request.data).length, before);
  } finally { if (result?.run_file) await exec(process.execPath, [script, 'close', '--run', result.run_file]); }
});

test('production MCP exports both providers through existing sessions with correct roles and archive contents', async () => {
  const client = new Client({ name: 'both-providers-test', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '../mcp.mjs')], stderr: 'pipe' });
  let sessionId;
  try {
    await client.connect(transport);
    for (const service of services) {
      const opened = await client.callTool({ name: 'open_export_session', arguments: { provider: service, workspace: 'mcp-both', out: join(root, 'mcp-' + service), cdp_endpoint: endpoint,
        initial_options: { mode: 'urls', urls: ids.slice(0, 2).map(id => origins[service] + chatPath(service, id)), delay_ms: 1000 } } });
      assert.ok(!opened.isError, opened.content?.[0]?.text); sessionId = opened.structuredContent.session_id;
      const result = await wait(async () => (await client.callTool({ name: 'get_export_status', arguments: { session_id: sessionId } })).structuredContent);
      assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 2); assert.equal(result.zip.verification.verified, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_/); await checkArchive(result, service, 2);
      await client.callTool({ name: 'close_export_session', arguments: { session_id: sessionId } }); sessionId = null;
    }
  } finally { if (sessionId) await client.callTool({ name: 'close_export_session', arguments: { session_id: sessionId } }).catch(() => {}); await client.close(); }
});

for (const service of services) test(service + ' UI JSON access denial stops the queue without retrying or reading the next chat', async () => {
  const session = new ExportSession({ engineOptions: { waitMs: 5, delayMs: 0 } }); const from = requests.length;
  try {
    await session.open({ provider: service, workspace: 'denied', out: join(root, 'denied-' + service), cdp_endpoint: endpoint,
      initial_options: { mode: 'urls', urls: [ids[0], deniedId, ids[4]].map(id => origins[service] + chatPath(service, id)) } });
    const result = await wait(() => session.status()); assert.equal(result.phase, 'blocked'); assert.equal(result.counts.saved, 1);
    const called = requests.slice(from).filter(request => request.service === service);
    assert.equal(called.filter(request => request.data && request.id === deniedId).length, 1);
    assert.ok(!called.some(request => request.id === ids[4])); assert.ok(result.zip.verification.verified);
  } finally { await session.close(); }
});

test('both converters select the active branch and keep the entire original source without mutation', () => {
  for (const service of services) {
    const raw = payload(service, ids[0]), original = JSON.stringify(raw);
    const normalized = normalizeOfficial(raw, service);
    assert.deepEqual(normalized.messages.map(message => message.id), ['u', 'a']);
    assert.doesNotMatch(JSON.stringify(normalized.messages), /ABANDONED_BRANCH/);
    assert.equal(JSON.stringify(raw), original); assert.equal(normalized.raw, raw);
  }
});
test('Claude refuses ambiguous or cyclic branches and flags explicitly truncated text', () => {
  const ambiguous = payload('claude', ids[0]); delete ambiguous.current_leaf_message_uuid;
  assert.throws(() => normalizeOfficial(ambiguous, 'claude'), error => error.code === 'claude_branch_unresolved');
  const missing = payload('claude', ids[0]); missing.current_leaf_message_uuid = 'missing';
  assert.throws(() => normalizeOfficial(missing, 'claude'), error => error.code === 'claude_branch_unresolved');
  const cycle = payload('claude', ids[0]); cycle.chat_messages.find(message => message.uuid === 'u').parent_message_uuid = 'a';
  assert.throws(() => normalizeOfficial(cycle, 'claude'), /Цикл/);
  const disconnected = payload('claude', ids[0]); for (const message of disconnected.chat_messages) message.parent_message_uuid = null;
  assert.throws(() => normalizeOfficial(disconnected, 'claude'), error => error.code === 'claude_branch_unresolved');
  const truncated = payload('claude', ids[0]); truncated.chat_messages[1].truncated = true;
  assert.ok(normalizeOfficial(truncated, 'claude').warnings.some(warning => warning.includes('truncated')));
});
test('verify checks one actual browser conversation per provider without returning its contents', async () => {
  const report = await verifyProviders({ provider: 'all', out: join(root, 'verify'), cdp_endpoint: endpoint });
  assert.equal(report.verified_all, true); assert.equal(report.all_account_chats_verified, false);
  assert.equal(report.json_verified_all, true);
  for (const service of services) { assert.equal(report.providers[service].verified, true); assert.equal(report.providers[service].json_capture_verified, true); assert.equal(report.providers[service].message_count, 2); }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_|ABANDONED_BRANCH/);
  assert.equal(context.browser().isConnected(), true);
  assert.equal(context.pages().filter(page => /\/(c|chat)\//.test(page.url())).length, 2);
});
test('verify never reports success without a source session and writes a failure report for both providers', async () => {
  const report = await verifyProviders({ provider: 'all', out: join(root, 'verify-missing'), sessionFactory: () => ({
    open: async () => { const error = new Error('No source tab'); error.code = 'no_source_tab'; throw error; }, close: async () => {},
  }) });
  assert.equal(report.verified_all, false);
  assert.equal(report.json_verified_all, false);
  assert.deepEqual(report.requested_providers, services);
  for (const service of services) assert.equal(report.providers[service].failure_code, 'no_source_tab');
  assert.equal(JSON.parse(await readFile(report.report_file, 'utf8')).verified_all, false);
});

test('an unresolved Claude branch keeps the full raw JSON and the readable UI thread, with a partial status', async () => {
  const session = new ExportSession({ engineOptions: { waitMs: 5, delayMs: 0, readinessMs: 200 } });
  try {
    await session.open({ provider: 'claude', workspace: 'ambiguous', out: join(root, 'ambiguous'), cdp_endpoint: endpoint,
      initial_options: { mode: 'urls', urls: [origins.claude + chatPath('claude', ambiguousId)] } });
    const result = await wait(() => session.status()); assert.equal(result.phase, 'needs_review'); assert.equal(result.counts.partial, 1); assert.equal(result.counts.saved, 0);
    const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
    const saved = JSON.parse(await readFile(join(result.out, manifest.chats[ambiguousId].jsonFile), 'utf8'));
    assert.equal(saved.raw.uuid, ambiguousId); assert.equal(saved.raw.chat_messages.length, 3);
    assert.deepEqual(saved.messages.map(message => message.text), ['Visible question', 'Visible answer']);
    assert.ok(saved.warnings.some(warning => warning.includes('JSON')));
    assert.equal(result.zip.verification.verified, true);
  } finally { await session.close(); }
});
