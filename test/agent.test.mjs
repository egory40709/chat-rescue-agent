import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorker, readRun } from '../agent.mjs';
import { savedIntact, openArchive, sha256 } from '../lib/archive.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { fixtureSession } from './fixtures.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let root, client, transport;
const stderr = [];
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-agent-test-'));
  await connect();
});
after(async () => {
  await client?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function connect() {
  transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, 'fixture-server.mjs')],
    env: { ...process.env, FIXTURE_ROOT: root }, stderr: 'pipe' });
  client = new Client({ name: 'chat-rescue-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', data => stderr.push(data.toString()));
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content?.[0]?.text);
  const data = result.structuredContent || JSON.parse(result.content[0].text);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_FIXTURE_(QUESTION|ANSWER)/, 'Chat contents must not be returned to the model');
  return data;
}
async function waitFor(fn, predicate, timeout = 15000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    last = await fn(); if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error('Timed out: ' + JSON.stringify(last));
}
const terminal = state => ['complete', 'needs_review', 'blocked', 'failed', 'paused'].includes(state.phase);
const open = (workspace, provider = 'chatgpt') => call('open_export_session', { provider, workspace, browser: 'chromium', out: join(root, workspace) });

let sessionId, completed;
test('real MCP stdio handshake exposes twelve tools and an agent workflow prompt', async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 12);
  assert.ok(tools.tools.some(tool => tool.name === 'start_export'));
  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts[0].name, 'export_my_chats');
  const prompt = await client.getPrompt({ name: 'export_my_chats', arguments: { provider: 'chatgpt', workspace: 'work' } });
  assert.match(prompt.messages[0].content.text, /уже открытую локальную вкладку/);
});
test('explicit isolated mode retains the manual login gate', async () => {
  const opened = await open('mcp-work'); sessionId = opened.session_id;
  assert.equal(opened.phase, 'awaiting_login');
  const result = await client.callTool({ name: 'start_export', arguments: { session_id: sessionId, user_ready: false } });
  assert.equal(result.isError, true);
  const status = await call('get_export_status', { session_id: sessionId });
  assert.equal(status.total, 0);
  const inspected = await call('inspect_export_session', { session_id: sessionId });
  assert.equal(inspected.ui_chat_links, 2);
  assert.equal(inspected.workspace_verified, false);
});
test('one MCP action discovers chats, exports in background and assembles a real ZIP', async () => {
  const started = Date.now();
  const running = await call('start_export', { session_id: sessionId, user_ready: true });
  assert.ok(running.job_id);
  assert.ok(Date.now() - started < 2000, 'Tool should start a job, not block for the full export');
  completed = await waitFor(() => call('get_export_status', { session_id: sessionId }), terminal);
  assert.equal(completed.phase, 'complete', JSON.stringify(completed));
  assert.equal(completed.counts.saved, 2);
  assert.equal(completed.coverage, 'unverified');
  const zip = await readFile(completed.zip.path);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(sha256(zip), completed.zip.sha256);
  const qa = resolve(import.meta.dirname, '../qa'); await mkdir(qa, { recursive: true });
  await writeFile(join(qa, 'export-sample.zip'), zip);
  const manifest = await openArchive(completed.out, 'chatgpt', 'mcp-work');
  for (const entry of Object.values(manifest.chats)) assert.equal(await savedIntact(completed.out, entry), true);
  const markdown = await readFile(join(completed.out, manifest.chats.one.markdownFile), 'utf8');
  assert.match(markdown, /PRIVATE_FIXTURE_ANSWER_one/);
  assert.match(markdown, /const value = 42/);
  assert.equal((await readdir(completed.out)).some(name => name.startsWith('chat-rescue-chatgpt-') && name.endsWith('.zip')), true);
});
test('a repeated automatic MCP run checks saved hashes without re-reading chats', async () => {
  const before = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length;
  await call('start_export', { session_id: sessionId, user_ready: true });
  const result = await waitFor(() => call('get_export_status', { session_id: sessionId }), terminal);
  assert.equal(result.phase, 'complete');
  const after = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length;
  assert.equal(after, before);
});
test('MCP client/process restart preserves files and resumes the existing queue', async () => {
  await call('close_export_session', { session_id: sessionId });
  await client.close(); await connect();
  const reopened = await open('mcp-work'); sessionId = reopened.session_id;
  assert.equal(reopened.counts.saved, 2);
  assert.equal(reopened.selected_scope_confirmed_by_user, false);
  await call('resume_export', { session_id: sessionId, user_ready: true });
  const result = await waitFor(() => call('get_export_status', { session_id: sessionId }), terminal);
  assert.equal(result.phase, 'complete');
  assert.equal(result.counts.saved, 2);
  await call('close_export_session', { session_id: sessionId });
});
test('explicit denial blocks MCP queue, never reads the next chat, and still permits a partial ZIP', async () => {
  const opened = await open('mcp-blocked');
  await call('start_export', { session_id: opened.session_id, user_ready: true, mode: 'urls',
    urls: ['https://chatgpt.com/c/blocked', 'https://chatgpt.com/c/not-read'] });
  const result = await waitFor(() => call('get_export_status', { session_id: opened.session_id }), terminal);
  assert.equal(result.phase, 'blocked'); assert.match(result.last_error, /403/);
  assert.deepEqual(result.counts, { pending: 1, saved: 0, partial: 0, failed: 1 });
  const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).url);
  assert.equal(requests.filter(url => url.endsWith('/blocked')).length, 1);
  assert.ok(!requests.some(url => url.endsWith('/not-read')));
  const packed = await call('create_export_zip', { session_id: opened.session_id });
  assert.ok(packed.zip.path.endsWith('.zip')); assert.equal(packed.phase, 'blocked');
  await call('close_export_session', { session_id: opened.session_id });
});
test('MCP accepts Claude and rejects foreign URLs before starting a job', async () => {
  const opened = await open('mcp-claude', 'claude');
  const denied = await client.callTool({ name: 'start_export', arguments: { session_id: opened.session_id, user_ready: true,
    mode: 'urls', urls: ['https://evil.example/chat/x'] } });
  assert.equal(denied.isError, true);
  await call('start_export', { session_id: opened.session_id, user_ready: true });
  const result = await waitFor(() => call('get_export_status', { session_id: opened.session_id }), terminal);
  assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 2);
  await call('close_export_session', { session_id: opened.session_id });
});
test('losing the MCP process mid-export keeps its queue for a new client', async () => {
  const opened = await open('mcp-interrupted');
  await call('start_export', { session_id: opened.session_id, user_ready: true, mode: 'urls',
    urls: Array.from({ length: 10 }, (_, i) => 'https://chatgpt.com/c/reconnect-' + i) });
  await waitFor(() => call('get_export_status', { session_id: opened.session_id }), value => value.total === 10);
  await client.close();
  await connect();
  const reopened = await open('mcp-interrupted');
  assert.equal(reopened.total, 10);
  assert.equal(reopened.counts.failed, 0);
  await call('resume_export', { session_id: reopened.session_id, user_ready: true });
  const result = await waitFor(() => call('get_export_status', { session_id: reopened.session_id }), terminal);
  assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 10);
  await call('close_export_session', { session_id: reopened.session_id });
});
test('noninteractive CLI worker starts, accepts commands, exports and closes without TTY', async () => {
  const out = join(root, 'cli-work');
  const started = await startWorker({ provider: 'chatgpt', workspace: 'cli-work', browser: 'chromium', out, fixture_root: root },
    { workerScript: resolve(import.meta.dirname, 'fixture-worker.mjs') });
  const run = started.run_file;
  try {
    await waitFor(() => readRun(run), state => state.phase === 'awaiting_login');
    const args = [resolve(import.meta.dirname, '../agent.mjs')];
    const ready = await exec(process.execPath, [...args, 'continue', '--run', run]);
    assert.ok(JSON.parse(ready.stdout).job_id);
    const result = await waitFor(async () => JSON.parse((await exec(process.execPath, [...args, 'status', '--run', run])).stdout), terminal);
    assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 2);
    const packed = JSON.parse((await exec(process.execPath, [...args, 'pack', '--run', run])).stdout);
    assert.ok(packed.zip.path.endsWith('.zip'));
    const duplicate = await startWorker({ provider: 'chatgpt', workspace: 'cli-work', browser: 'chromium', out, fixture_root: root },
      { workerScript: resolve(import.meta.dirname, 'fixture-worker.mjs') });
    assert.equal(duplicate.reused, true); assert.equal(duplicate.pid, result.pid);
    const closed = JSON.parse((await exec(process.execPath, [...args, 'close', '--run', run])).stdout);
    assert.equal(closed.browser_closed, true);
    await waitFor(() => readRun(run), state => !state.worker_alive);
  } finally {
    if ((await readRun(run)).worker_alive) await exec(process.execPath, [resolve(import.meta.dirname, '../agent.mjs'), 'close', '--run', run]).catch(() => {});
  }
});
test('stop and limit pauses have distinct reasons; resume preserves saved hashes', async () => {
  const session = fixtureSession(root, 'direct', 30);
  try {
    await session.open({ provider: 'chatgpt', workspace: 'pauses', out: join(root, 'pauses'), browser: 'chromium' });
    await session.start({ user_ready: true, mode: 'urls', urls: ['https://chatgpt.com/c/limit-one', 'https://chatgpt.com/c/limit-two'], limit: 1 });
    const limited = await waitFor(() => session.status(), terminal);
    assert.equal(limited.phase, 'paused'); assert.equal(limited.stop_reason, 'limit_reached'); assert.equal(limited.counts.saved, 1);
    await session.resume({ user_ready: true });
    const resumed = await waitFor(() => session.status(), terminal);
    assert.equal(resumed.phase, 'complete'); assert.equal(resumed.counts.saved, 2);
    await session.start({ user_ready: true, mode: 'urls', urls: Array.from({ length: 10 }, (_, i) => 'https://chatgpt.com/c/stop-' + i) });
    await session.stop();
    const stopped = await waitFor(() => session.status(), terminal);
    assert.equal(stopped.phase, 'paused'); assert.equal(stopped.stop_reason, 'user_requested'); assert.equal(stopped.counts.failed, 0);
  } finally { await session.close(); }
});
test('resume arriving during the final paused-state write waits and starts the remaining queue', async () => {
  const session = fixtureSession(root, 'direct', 30);
  let releaseFinalWrite, holdingFinalWrite = false;
  const finalWrite = new Promise(resolve => { releaseFinalWrite = resolve; });
  const persist = session.persist.bind(session);
  session.persist = async () => {
    if (!holdingFinalWrite && session.state.phase === 'paused' && session.job) {
      holdingFinalWrite = true; await finalWrite;
    }
    return persist();
  };
  try {
    await session.open({ provider: 'chatgpt', workspace: 'resume-final-write', out: join(root, 'resume-final-write'), browser: 'chromium' });
    await session.start({ user_ready: true, mode: 'urls', urls: ['https://chatgpt.com/c/resume-one', 'https://chatgpt.com/c/resume-two'], limit: 1 });
    await waitFor(() => session.status(), state => state.phase === 'paused');
    assert.equal(holdingFinalWrite, true);
    let resumeReturned = false;
    const resumed = session.resume({ user_ready: true }).then(status => { resumeReturned = true; return status; });
    await sleep(30); assert.equal(resumeReturned, false, 'Resume must not return the previous paused job');
    releaseFinalWrite(); await resumed;
    const result = await waitFor(() => session.status(), terminal);
    assert.equal(result.phase, 'complete', JSON.stringify(result)); assert.equal(result.counts.saved, 2);
  } finally { releaseFinalWrite(); await session.close(); }
});
test('lock refuses live writers and retains unknown locks instead of deleting them', async () => {
  const out = join(root, 'locks');
  const release = await acquireLock(out);
  await assert.rejects(acquireLock(out), /другим процессом/);
  await release();
  await mkdir(join(out, '.agent-lock'));
  await writeFile(join(out, '.agent-lock', 'owner.json'), '{}');
  await assert.rejects(acquireLock(out), /занят|процессом/);
  assert.ok((await readFile(join(out, '.agent-lock/owner.json'), 'utf8')) === '{}');
});
test('a stale lock from an exited process is retained and safely replaced', async () => {
  const child = await exec(process.execPath, ['-e', 'console.log(process.pid)']);
  const out = join(root, 'stale-lock'); await mkdir(join(out, '.agent-lock'), { recursive: true });
  const old = { pid: Number(child.stdout.trim()), id: 'old-run' };
  await writeFile(join(out, '.agent-lock/owner.json'), JSON.stringify(old));
  const release = await acquireLock(out);
  assert.ok((await readdir(out)).some(name => name.startsWith('.agent-lock-stale-')));
  await release();
});
test('concurrent starts share one job instead of duplicating export requests', async () => {
  const session = fixtureSession(root, 'direct');
  try {
    await session.open({ provider: 'chatgpt', workspace: 'concurrent', out: join(root, 'concurrent'), browser: 'chromium' });
    const options = { user_ready: true, mode: 'urls', urls: ['https://chatgpt.com/c/single-job'] };
    const [one, two] = await Promise.all([session.start(options), session.start(options)]);
    assert.equal(one.job_id, two.job_id);
    const result = await waitFor(() => session.status(), terminal);
    assert.equal(result.counts.saved, 1);
    const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).url);
    assert.equal(requests.filter(url => url.endsWith('/single-job')).length, 1);
  } finally { await session.close(); }
});
test('MCP stdout remains valid protocol traffic and chat text never leaks to stderr', () => {
  assert.doesNotMatch(stderr.join(''), /PRIVATE_FIXTURE_(QUESTION|ANSWER)/);
  assert.doesNotMatch(stderr.join(''), /SyntaxError|UnhandledPromiseRejection/);
});
