import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TOOL_VERSION } from '../lib/version.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { chromium } from 'playwright';
import { NativeMacPage, AttachedContext } from '../lib/existing-browser.mjs';
import { ExportSession } from '../lib/session.mjs';
import { captureChat } from '../lib/engine.mjs';
import { conversationRecord } from '../lib/conversation-source.mjs';
import { packArchive } from '../lib/pack.mjs';
import { verifyZip } from '../lib/verification.mjs';
import { startWorker, sendCommand, waitForExport } from '../agent.mjs';

let root, browser, context;
const requests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function record(id) {
  return { conversation_id: id, title: 'Test conversation', current_node: 'a', mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, content: { parts: ['PRIVATE_RELIABILITY_QUESTION_' + id] } } },
    a: { parent: 'u', message: { id: 'a', author: { role: 'assistant' }, status: 'finished_successfully', content: { parts: ['PRIVATE_RELIABILITY_ANSWER_' + id] } } },
  } };
}
const nav = '<aside>' + Array.from({ length: 5 }, (_, i) => '<a href="/c/json-' + i + '">Chat ' + i + '</a>').join('') + '</aside>';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-reliability-'));
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  context = await browser.newContext(); await context.setOffline(true);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); const id = url.pathname.split('/').at(-1);
    requests.push(url.pathname);
    if (id === 'native-json' && url.pathname.startsWith('/actual-ui/conversation/') && await route.request().headerValue('authorization') !== 'Bearer SYNTHETIC_UI_ONLY') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    if (id === 'slow-source' && url.pathname.startsWith('/actual-ui/conversation/')) await sleep(150);
    if (url.pathname.startsWith('/actual-ui/conversation/')) return route.fulfill({ status: id === 'api-denied' ? 403 : 200, contentType: 'application/json', body: JSON.stringify(record(id)) });
    const body = id === 'slow-source' ? '<main><article data-message-author-role="assistant">WRONG_OLD_DOCUMENT</article></main><script>fetch("/actual-ui/conversation/slow-source").then(r=>r.json())</script>' : id.startsWith('json-') || ['api-denied', 'native-json'].includes(id)
      ? '<main><section>New UI without role attributes</section></main><script>fetch("/actual-ui/conversation/' + id + '").then(r=>r.json()).then(()=>{window.uiReady=true})</script>'
      : id.startsWith('partial') ? '<main>Readable page without recognised roles</main>'
        : '<main><article data-turn="user">MODERN_USER_' + id + '</article><article data-turn="assistant"><div class="markdown">First block</div><div class="markdown">Second block</div></article></main>';
    await route.fulfill({ status: id === 'one-404' ? 404 : 200, contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' + nav + body });
  });
});
after(async () => { await browser?.close(); if (root) await rm(root, { recursive: true, force: true }); });
function exporter(extra = {}) {
  return new ExportSession({ engineOptions: { waitMs: 5, delayMs: 0, readinessMs: 200 }, attach: async () => {
    const page = await context.newPage(); await page.goto('https://chatgpt.com/c/home');
    return new AttachedContext(page, () => page.close(), { method: 'test-existing' });
  }, ...extra });
}
async function done(session) {
  const started = Date.now(); let result;
  do { result = await session.status(); if (['complete', 'needs_review', 'failed', 'blocked', 'paused'].includes(result.phase)) return result; await sleep(20); } while (Date.now() - started < 15000);
  throw new Error('Export did not finish: ' + JSON.stringify(result));
}

test('macOS waits for the requested URL when loading=false still belongs to the old document', async () => {
  let url = 'https://chatgpt.com/c/old', navigated = 0, reads = 0;
  const page = new NativeMacPage({ app: 'Google Chrome', provider: 'chatgpt', reference: { windowId: 7, tabId: '42' }, bridge: async input => {
    assert.equal(input.tabId, '42');
    if (input.action === 'navigate') { navigated = Date.now(); return { ok: true }; }
    if (input.action === 'info') { reads++; if (navigated && Date.now() - navigated >= 900) url = 'https://chatgpt.com/c/new'; return { url, loading: false }; }
  } });
  const started = Date.now(); await page.goto('https://chatgpt.com/c/new', { timeout: 3000 });
  assert.ok(Date.now() - started >= 900); assert.equal(await page.url(), 'https://chatgpt.com/c/new'); assert.ok(reads > 5);
});
test('five ChatGPT conversations export with correct roles even when every DOM role selector is missing', async () => {
  const session = exporter();
  try {
    await session.open({ provider: 'chatgpt', workspace: 'five', out: join(root, 'five') });
    const result = await done(session); assert.equal(result.phase, 'complete', JSON.stringify(result));
    assert.equal(result.counts.saved, 5); assert.equal(result.counts.partial, 0); assert.equal(result.counts.failed, 0);
    assert.equal(result.zip.verification.verified, true);
    const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
    for (const [id, entry] of Object.entries(manifest.chats)) {
      const saved = JSON.parse(await readFile(join(result.out, entry.jsonFile), 'utf8'));
      assert.equal(saved.id, id); assert.equal(saved.method, 'observed-ui-json-v1');
      assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant']);
      assert.match(saved.messages[1].text, new RegExp('PRIVATE_RELIABILITY_ANSWER_' + id));
    }
    const diagnostics = await readFile(result.diagnostics_file, 'utf8'); assert.doesNotMatch(diagnostics, /PRIVATE_RELIABILITY_(QUESTION|ANSWER)/);
    assert.equal(JSON.parse(diagnostics).attempts.filter(item => item.outcome === 'saved_json').length, 5);
  } finally { await session.close(); }
});
test('native macOS observes the UI fetch without extra requests or reading its authorization header', async () => {
  const work = await context.newPage(); await work.goto('https://chatgpt.com/c/home'); const started = requests.length;
  const adapter = {
    goto: async url => { await work.evaluate(async url => { history.pushState({}, '', url); document.querySelector('main').innerHTML = 'Changed UI without roles'; await fetch('/actual-ui/conversation/native-json', { headers: { Authorization: 'Bearer SYNTHETIC_UI_ONLY' } }).then(response => response.json()); }, url); return null; }, url: () => work.url(), isClosed: () => work.isClosed(), evaluate: (...args) => work.evaluate(...args),
  };
  try {
    const chat = await captureChat(adapter, 'chatgpt', { id: 'native-json', url: 'https://chatgpt.com/c/native-json' }, { waitMs: 5, readinessMs: 2000 });
    assert.equal(chat.method, 'observed-ui-json-v1'); assert.equal(chat.source_transport, 'passive-browser-fetch');
    assert.equal(requests.slice(started).filter(path => path === '/actual-ui/conversation/native-json').length, 1);
  } finally { await work.close(); }
});
test('a JSON record for another conversation cannot be mistaken for the requested conversation', () => {
  assert.equal(conversationRecord(record('other'), 'chatgpt', 'requested'), null);
  assert.equal(conversationRecord({ data: { conversation: record('requested') } }, 'chatgpt', 'requested').conversation_id, 'requested');
});
test('modern explicit roles and multiple Markdown blocks are retained without inventing alternating roles', async () => {
  const page = await context.newPage();
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'modern', url: 'https://chatgpt.com/c/modern' }, { waitMs: 5, readinessMs: 200 });
    assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant']);
    assert.match(chat.messages[1].markdown, /First block/); assert.match(chat.messages[1].markdown, /Second block/);
  } finally { await page.close(); }
});
test('two partial snapshots and one unreadable chat do not discard the remaining two readable chats', async () => {
  const session = exporter();
  try {
    await session.open({ provider: 'chatgpt', workspace: 'partials', out: join(root, 'partials'), initial_options: { mode: 'urls', urls: ['partial-1', 'partial-2', 'one-404', 'modern-4', 'modern-5'].map(id => 'https://chatgpt.com/c/' + id) } });
    const result = await done(session); assert.equal(result.phase, 'needs_review');
    assert.equal(result.counts.saved, 2); assert.equal(result.counts.partial, 2); assert.equal(result.counts.failed, 1); assert.equal(result.counts.pending, 0);
    assert.equal(result.zip.verification.verified, true);
  } finally { await session.close(); }
});
test('an access denial in the UI JSON response stops without another GET and still creates the saved archive', async () => {
  const session = exporter(); const from = requests.length;
  try {
    await session.open({ provider: 'chatgpt', workspace: 'denied', out: join(root, 'denied'), initial_options: { mode: 'urls', urls: ['json-0', 'api-denied', 'never-read'].map(id => 'https://chatgpt.com/c/' + id) } });
    const result = await done(session); assert.equal(result.phase, 'blocked'); assert.equal(result.counts.saved, 1); assert.ok(result.zip.path);
    assert.ok(!requests.slice(from).includes('/c/never-read'));
    assert.equal(requests.slice(from).filter(path => path === '/actual-ui/conversation/api-denied').length, 1);
  } finally { await session.close(); }
});
test('wait does not call an opening worker finished and independently checks the final ZIP', async () => {
  const session = exporter();
  try {
    const opening = await session.open({ provider: 'chatgpt', workspace: 'wait', out: join(root, 'wait') });
    const final = await waitForExport(opening.run_file, { timeout: 10000, interval: 10 });
    assert.equal(final.phase, 'complete'); assert.equal(final.export_finished, true); assert.equal(final.export_succeeded, true); assert.equal(final.archive_verification.verified, true);
    await writeFile(final.zip.path, 'tampered');
    assert.equal((await verifyZip(final.out, final.zip)).verified, false);
    assert.equal((await waitForExport(final.run_file)).export_succeeded, false);
  } finally { await session.close(); }
});

test('native macOS routing, passive JSON capture and packaging complete all five chats together', async () => {
  const original = await context.newPage(); await original.goto('https://chatgpt.com/c/home');
  const session = new ExportSession({ engineOptions: { waitMs: 5, delayMs: 0, readinessMs: 1000 }, attach: async () => {
    const work = await context.newPage(); await work.goto(original.url());
    await work.evaluate(() => {
      document.querySelector('aside').addEventListener('click', event => {
        const link = event.target.closest('a'); if (!link) return; event.preventDefault();
        history.pushState({}, '', link.href); document.querySelector('main').innerHTML = 'UI changed, no role selectors';
        const id = new URL(link.href).pathname.split('/').pop();
        fetch('/actual-ui/conversation/' + id).then(response => response.json());
      });
    });
    const page = new NativeMacPage({ app: 'Google Chrome', provider: 'chatgpt', reference: { windowId: 7, tabId: '99' }, bridge: async input => {
      if (input.action === 'info') return { url: work.url(), loading: false };
      if (input.action === 'execute') return JSON.parse(await work.evaluate(input.script));
      if (input.action === 'navigate') { await work.goto(input.url); return { ok: true }; }
      if (input.action === 'close') { await work.close(); return { ok: true }; }
    } });
    return new AttachedContext(page, () => page.close(), { method: 'macos-bridge-simulation' });
  } });
  try {
    await session.open({ provider: 'chatgpt', workspace: 'native-five', out: join(root, 'native-five') });
    const result = await done(session); assert.equal(result.phase, 'complete', JSON.stringify(result));
    assert.equal(result.counts.saved, 5); assert.equal(result.counts.partial, 0); assert.equal(result.zip.verification.verified, true);
    await exec(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; m=json.loads(z.read("manifest.json")); assert len(m["chats"])==5; docs=[json.loads(z.read(e["jsonFile"])) for e in m["chats"].values()]; assert all(d["method"]=="observed-ui-json-v1" and [v["role"] for v in d["messages"]]==["user","assistant"] for d in docs)', result.zip.path]);
    assert.equal(original.isClosed(), false); assert.equal(original.url(), 'https://chatgpt.com/c/home');
    const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
    for (const entry of Object.values(manifest.chats)) {
      const saved = JSON.parse(await readFile(join(result.out, entry.jsonFile), 'utf8'));
      assert.equal(saved.source_transport, 'passive-browser-fetch');
    }
  } finally { await session.close(); await original.close(); }
});
test('a terminal error is exposed only after its partial archive has finished writing', async () => {
  const session = exporter({ packageArchive: async (...args) => { await sleep(150); return packArchive(...args); } });
  let observedFinalizing = false;
  try {
    await session.open({ provider: 'chatgpt', workspace: 'finalization', out: join(root, 'finalization'), initial_options: { mode: 'urls', urls: ['https://chatgpt.com/c/api-denied'] } });
    for (let i = 0; i < 200; i++) {
      const status = await session.status(); observedFinalizing ||= status.phase === 'finalizing';
      if (status.phase === 'blocked') { assert.ok(status.zip?.verification.verified); break; }
      await sleep(5);
    }
    assert.equal((await session.status()).phase, 'blocked'); assert.equal(observedFinalizing, true);
  } finally { await session.close(); }
});
test('an idle older worker is closed through its own protocol and upgraded while saved chats are kept', async () => {
  const out = join(root, 'upgrade'); const options = { provider: 'chatgpt', workspace: 'upgrade', out, connection: 'isolated', fixture_root: root };
  const workerScript = fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url));
  let run = await startWorker(options, { workerScript });
  try {
    await sendCommand(run.run_file, 'continue', { mode: 'all' });
    const first = await waitForExport(run.run_file, { timeout: 15000, interval: 20 });
    assert.equal(first.phase, 'complete');
    const state = JSON.parse(await readFile(run.run_file, 'utf8')); state.tool_version = '1.2.0'; await writeFile(run.run_file, JSON.stringify(state));
    const oldPid = run.pid;
    run = await startWorker(options, { workerScript });
    assert.notEqual(run.pid, oldPid); assert.equal(run.tool_version, TOOL_VERSION);
    assert.equal(run.counts.saved, first.counts.saved);
  } finally { await sendCommand(run.run_file, 'close'); }
});
test('a mid-read same-site navigation is repaired once and the other page never enters the saved transcript', async () => {
  const work = await context.newPage(); let shifted = false, navigations = 0;
  const adapter = {
    on: (...args) => work.on(...args), off: (...args) => work.off(...args),
    url: () => work.url(), isClosed: () => work.isClosed(),
    goto: (...args) => { navigations++; return work.goto(...args); },
    evaluate: async (fn, args) => {
      if (args?.action === 'down' && !shifted) { shifted = true; await work.goto('https://chatgpt.com/c/other-conversation'); }
      return work.evaluate(fn, args);
    },
  };
  try {
    const chat = await captureChat(adapter, 'chatgpt', { id: 'modern-drift', url: 'https://chatgpt.com/c/modern-drift' }, { waitMs: 5, readinessMs: 200 });
    assert.equal(navigations, 2); assert.match(chat.messages[0].text, /modern-drift/);
    assert.doesNotMatch(JSON.stringify(chat), /MODERN_USER_other-conversation/);
  } finally { await work.close(); }
});

test('accessible author labels identify roles when ChatGPT turn attributes have changed', async () => {
  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/c/accessible');
    await page.setContent('<main><article data-testid="conversation-turn-0"><h5 class="sr-only">You said:</h5><div class="markdown">Question</div></article><article data-testid="conversation-turn-1"><h6 class="sr-only">ChatGPT said:</h6><div class="markdown">Answer</div></article></main>');
    const chat = await captureChat(page, 'chatgpt', { id: 'accessible', url: page.url() }, { waitMs: 5, navigate: false, readinessMs: 200 });
    assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(chat.messages[0].markdown, 'Question'); assert.equal(chat.messages[1].markdown, 'Answer');
  } finally { await page.close(); }
});

test('an in-flight conversation request prevents stale role-labelled DOM from being saved', async () => {
  const page = await context.newPage();
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'slow-source', url: 'https://chatgpt.com/c/slow-source' }, { waitMs: 5, readinessMs: 1000 });
    assert.equal(chat.method, 'observed-ui-json-v1');
    assert.match(chat.messages[1].text, /PRIVATE_RELIABILITY_ANSWER_slow-source/);
    assert.doesNotMatch(JSON.stringify(chat), /WRONG_OLD_DOCUMENT/);
  } finally { await page.close(); }
});
