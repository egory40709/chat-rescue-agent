import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { readPage } from '../lib/dom.mjs';
import { ExportSession } from '../lib/session.mjs';
import { captureChat } from '../lib/engine.mjs';
import { verifyProviders } from '../lib/verify-providers.mjs';

const exec = promisify(execFile), origin = 'https://chatgpt.com';
let root, context, source, endpoint, sourceTab;
const requests = [];
// Structural reproduction of the reported error; no employee IP, Ray ID or SVG.
const errorHtml = '<!doctype html><meta charset="utf-8"><body><div class="container"><div class="logo"></div>'
  + '<div class="message"><svg class="blocked-icon" width="24" height="24"></svg><p>Unable to load site</p></div>'
  + '<span class="explanation">Please try again later. If you are using a VPN, try turning it off. Check the '
  + '<a href="https://status.openai.com/">status page</a> for information on outages.</span>'
  + '<span class="explanation">[IP:203.0.113.8 | Ray ID:SYNTHETIC_PRIVATE_RAY]</span></div></body>';
const domHtml = '<!doctype html><meta charset="utf-8"><aside><a href="/c/dom">Fixture</a></aside><main>'
  + '<article data-message-author-role="user">PRIVATE_ACCESS_QUESTION</article>'
  + '<article data-message-author-role="assistant">PRIVATE_ACCESS_ANSWER</article></main>';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-access-'));
  const profile = join(root, 'browser');
  context = await chromium.launchPersistentContext(profile, { headless: true, chromiumSandbox: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  await context.setOffline(true);
  await context.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    if (path.startsWith('/c/unavailable')) return route.fulfill({ status: path.endsWith('503') ? 503 : 200, contentType: 'text/html', body: errorHtml });
    if (path.startsWith('/actual-ui/conversation/source-error-')) return route.fulfill({ status: path.endsWith('503') ? 503 : 200, contentType: 'text/html', body: errorHtml });
    if (path === '/actual-ui/conversation/quoted-json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: 'quoted-json', current_node: 'a', mapping: {
      u: { parent: null, message: { author: { role: 'user' }, content: { parts: [errorHtml] } } },
      a: { parent: 'u', message: { author: { role: 'assistant' }, content: { parts: ['Explanation'] } } },
    } }) });
    if (path.startsWith('/actual-ui/conversation/')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: path.endsWith('invalid') ? '{broken' : JSON.stringify({ conversation_id: 'reload', current_node: 'a', mapping: {
        u: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Question'] } } },
        a: { parent: 'u', message: { author: { role: 'assistant' }, content: { parts: ['Answer'] } } },
      } }) });
    if (['/c/reload', '/c/invalid', '/c/quoted-json'].includes(path) || path.startsWith('/c/source-error-')) return route.fulfill({ status: 200, contentType: 'text/html', body:
      '<!doctype html><main>Changed UI without role selectors</main><script>fetch("/actual-ui/conversation/' + path.split('/').at(-1) + '").then(r=>r.text())</script>' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: domHtml });
  });
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); endpoint = 'http://127.0.0.1:' + port;
  source = await context.newPage(); await source.goto(origin + '/c/dom');
  const cdp = await context.newCDPSession(source); sourceTab = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
});
after(async () => { await context?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test('the reported top-level error shell is recognised without exposing IP, Ray ID or HTML as a transcript', async () => {
  const page = await context.newPage();
  try {
    await page.goto(origin + '/c/unavailable');
    const meta = await page.evaluate(readPage, { provider: 'chatgpt', metadataOnly: true });
    assert.equal(meta.observable, false); assert.equal(meta.auth_barrier, false); assert.equal(meta.site_barrier.code, 'provider_site_unavailable');
    const read = await page.evaluate(readPage, { provider: 'chatgpt' });
    assert.deepEqual(read.messages, []); assert.equal(read.fallbackText, '');
    assert.doesNotMatch(JSON.stringify([meta, read]), /203\.0\.113\.8|SYNTHETIC_PRIVATE_RAY|turning it off/);
  } finally { await page.close(); }
});
for (const status of [200, 503]) test('an existing session with the error shell at HTTP ' + status + ' fails before discovery, without retry or a new login', async () => {
  const page = await context.newPage(); const url = origin + '/c/unavailable-' + status; await page.goto(url);
  const cdp = await context.newCDPSession(page); const tab = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
  const session = new ExportSession(); const from = requests.length; const out = join(root, 'initial-' + status);
  try {
    await assert.rejects(session.open({ provider: 'chatgpt', workspace: 'access', out, cdp_endpoint: endpoint, source_tab: tab }), error => error.code === 'provider_site_unavailable' && error.stopQueue);
    const result = await session.status(); assert.equal(result.phase, 'blocked'); assert.equal(result.total, 0); assert.equal(result.zip, null);
    assert.equal(result.error_code, 'provider_site_unavailable'); assert.equal(result.job_id, null);
    assert.equal(requests.slice(from).filter(path => path === new URL(url).pathname).length, 1);
    assert.ok(!requests.slice(from).some(path => /login|auth/.test(path)));
    assert.equal(JSON.parse(await readFile(join(out, 'run.json'), 'utf8')).error_code, 'provider_site_unavailable');
    assert.equal(page.isClosed(), false);
  } finally { await session.close(); await page.close(); }
});
test('production CLI stops at the error shell, preserves the first chat and exposes its code through diagnose', async () => {
  const script = resolve(import.meta.dirname, '../agent.mjs'), out = join(root, 'cli'), links = join(root, 'links.txt');
  await writeFile(links, ['dom', 'unavailable', 'never-read'].map(id => origin + '/c/' + id).join('\n'));
  const from = requests.length; let result;
  try {
    const { stdout } = await exec(process.execPath, [script, 'scrape', '--provider', 'chatgpt', '--workspace', 'access', '--out', out,
      '--cdp', endpoint, '--source-tab', sourceTab, '--urls-file', links, '--delay-ms', '1000']);
    result = JSON.parse(stdout); assert.equal(result.phase, 'blocked', stdout); assert.equal(result.export_succeeded, false);
    assert.equal(result.error_code, 'provider_site_unavailable'); assert.deepEqual(result.counts, { saved: 1, partial: 0, failed: 1, pending: 1 });
    assert.equal(result.archive_verification.verified, true);
    const diagnosis = JSON.parse((await exec(process.execPath, [script, 'diagnose', '--run', result.run_file])).stdout);
    assert.equal(diagnosis.error_code, 'provider_site_unavailable');
    assert.equal(diagnosis.diagnostics.attempts.filter(item => item.code === 'provider_site_unavailable').length, 1);
    assert.doesNotMatch(JSON.stringify(diagnosis), /PRIVATE_ACCESS_|203\.0\.113\.8|SYNTHETIC_PRIVATE_RAY/);
    assert.equal(requests.slice(from).filter(path => path === '/c/unavailable').length, 1);
    assert.ok(!requests.slice(from).includes('/c/never-read'));
    const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
    assert.equal(manifest.chats.unavailable.jsonFile, undefined);
  } finally { if (result?.run_file) await exec(process.execPath, [script, 'close', '--run', result.run_file]); }
});
test('the same error words and markup quoted inside a real chat are not an access barrier', async () => {
  const page = await context.newPage();
  try {
    await page.goto(origin + '/c/quoted'); await page.setContent('<main><article data-message-author-role="user">' + errorHtml + '</article><article data-message-author-role="assistant">Explanation</article></main>');
    const meta = await page.evaluate(readPage, { provider: 'chatgpt', metadataOnly: true });
    assert.equal(meta.observable, true); assert.equal(meta.site_barrier, null); assert.equal(meta.messages, 2);
    const chat = await captureChat(page, 'chatgpt', { id: 'quoted', url: page.url() }, { navigate: false, waitMs: 5, readinessMs: 500 });
    assert.equal(chat.messages.length, 2); assert.equal(chat.warnings.length, 0);
  } finally { await page.close(); }
});
test('a native full document navigation reports the lost JSON observer and never invents a successful JSON capture', async () => {
  const page = await context.newPage(); await page.goto(origin + '/c/dom'); const diagnostics = [], from = requests.length;
  const adapter = { goto: (...args) => page.goto(...args), url: () => page.url(), isClosed: () => page.isClosed(), evaluate: (...args) => page.evaluate(...args) };
  try {
    const chat = await captureChat(adapter, 'chatgpt', { id: 'reload', url: origin + '/c/reload' }, { waitMs: 5, readinessMs: 300, onDiagnostic: value => diagnostics.push(value) });
    assert.equal(chat.method, 'rendered-ui-v1'); assert.equal(chat.messages.length, 0); assert.ok(chat.warnings.length);
    assert.ok(diagnostics.some(item => item.outcome === 'json_unavailable' && item.code === 'native_observer_reset' && item.observer_resets === 1));
    assert.ok(!diagnostics.some(item => item.outcome === 'saved_json'));
    assert.equal(requests.slice(from).filter(path => path === '/actual-ui/conversation/reload').length, 1);
  } finally { await page.close(); }
});
test('a verified DOM export explicitly says JSON was not verified', async () => {
  const report = await verifyProviders({ provider: 'chatgpt', cdp_endpoint: endpoint, source_tab: sourceTab, out: join(root, 'verify-dom') });
  assert.equal(report.verified_all, true); assert.equal(report.json_verified_all, false);
  assert.equal(report.providers.chatgpt.method, 'rendered-ui-v1'); assert.equal(report.providers.chatgpt.json_capture_verified, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ACCESS_/);
});
test('malformed observed UI JSON has a specific content-free diagnostic', async () => {
  const page = await context.newPage(), diagnostics = [];
  try {
    await captureChat(page, 'chatgpt', { id: 'invalid', url: origin + '/c/invalid' }, { waitMs: 5, readinessMs: 300, onDiagnostic: value => diagnostics.push(value) });
    assert.ok(diagnostics.some(item => item.outcome === 'json_unavailable' && item.code === 'ui_response_invalid_json'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /broken|PRIVATE_ACCESS_/);
  } finally { await page.close(); }
});
for (const transport of ['cdp', 'native']) for (const status of [200, 503]) test(transport + ' recognises an HTML error instead of JSON at HTTP ' + status + ' without a second request', async () => {
  const page = await context.newPage(); await page.goto(origin + '/c/dom');
  const id = 'source-error-' + status, from = requests.length, diagnostics = [];
  const adapter = transport === 'cdp' ? page : {
    goto: async url => { await page.evaluate(async url => { history.pushState({}, '', url); const id = new URL(url).pathname.split('/').pop(); await fetch('/actual-ui/conversation/' + id).then(response => response.text()); }, url); },
    url: () => page.url(), isClosed: () => page.isClosed(), evaluate: (...args) => page.evaluate(...args),
  };
  try {
    await assert.rejects(captureChat(adapter, 'chatgpt', { id, url: origin + '/c/' + id }, { waitMs: 5, readinessMs: 2000, onDiagnostic: value => diagnostics.push(value) }), error => error.code === 'provider_site_unavailable' && error.stopQueue);
    assert.equal(requests.slice(from).filter(path => path === '/actual-ui/conversation/' + id).length, 1);
    assert.equal(diagnostics.filter(item => item.outcome === 'error').length, 1);
    assert.doesNotMatch(JSON.stringify(diagnostics), /203\.0\.113\.8|SYNTHETIC_PRIVATE_RAY|Unable to load site/);
  } finally { await page.close(); }
});
test('an error page quoted inside valid UI JSON remains an ordinary user message', async () => {
  const page = await context.newPage();
  try {
    const chat = await captureChat(page, 'chatgpt', { id: 'quoted-json', url: origin + '/c/quoted-json' }, { waitMs: 5, readinessMs: 2000 });
    assert.equal(chat.method, 'observed-ui-json-v1'); assert.equal(chat.messages[0].text, errorHtml); assert.equal(chat.warnings.length, 0);
  } finally { await page.close(); }
});
