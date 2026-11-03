import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discoverSkillRoots, collectLocalSkills, readSkillFiles, exportLocalSkills } from '../lib/skills-local.mjs';
import { exportSkills } from '../lib/skills.mjs';
import { validateSkillZip } from '../lib/skills-web.mjs';
import { AttachedContext } from '../lib/existing-browser.mjs';
import { makeZip } from '../lib/zip.mjs';

const exec = promisify(execFile);
let root, home, project, browser, context, source;
const requests = [], zipPackages = {}, pageErrors = [];
const definition = name => '---\nname: ' + name + '\ndescription: synthetic test skill\n---\nPRIVATE_SKILL_INSTRUCTIONS_' + name + '\n';
async function skill(path, name = 'test') {
  await mkdir(join(path, 'scripts'), { recursive: true });
  await mkdir(join(path, 'assets'), { recursive: true });
  await writeFile(join(path, 'SKILL.md'), definition(name));
  await writeFile(join(path, 'scripts/run.sh'), '#!/bin/sh\nprintf NEVER_EXECUTE_ME\n'); await chmod(join(path, 'scripts/run.sh'), 0o755);
  await writeFile(join(path, 'assets/template.bin'), Buffer.from([0, 255, 17, 2]));
}
async function zip(name) {
  return Buffer.from(await makeZip([{ name: name + '/SKILL.md', content: definition(name) },
    { name: name + '/assets/template.bin', content: Buffer.from([0, 255, 17, 2]) },
    { name: name + '/scripts/never-run.js', content: 'throw new Error("SKILL_CODE_MUST_NOT_RUN");', executable: true }]).arrayBuffer());
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-rescue-skills-')); home = join(root, 'home'); project = join(root, 'project');
  await mkdir(project, { recursive: true }); await exec('git', ['init', project]);
  await skill(join(home, '.agents/skills/modern'), 'modern');
  await skill(join(home, '.codex/skills/legacy'), 'legacy');
  await skill(join(home, '.codex/skills/.system/builtin'), 'builtin');
  await skill(join(home, '.claude/skills/claude-local'), 'claude-local');
  await skill(join(project, '.agents/skills/project-skill'), 'project-skill');
  await skill(join(home, '.codex/plugins/cache/acme/package/1/skills/plugin-skill'), 'plugin-skill');
  await writeFile(join(home, '.codex/auth.json'), 'ACCOUNT_CREDENTIALS_MUST_NOT_BE_READ');
  zipPackages.one = await zip('one'); zipPackages.two = await zip('two');
  browser = await chromium.launch({ headless: true, chromiumSandbox: true }); context = await browser.newContext(); await context.setOffline(true);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); requests.push({ url: url.href, method: route.request().method() });
    let body = '<!doctype html><main>Unexpected page</main>', status = 200;
    if (url.pathname === '/chat/source') body = '<main>Original Claude tab</main>';
    else if (url.pathname === '/customize/skills') body = '<main><a href="/customize/skills/one">Skill one</a><a href="/customize/skills/two">Skill two</a></main>';
    else if (url.pathname === '/customize/skills/one') body = '<main><h1>Skill one</h1><button onclick="const a=document.createElement(\'a\');a.download=\'one.zip\';a.href=window.URL.createObjectURL(new Blob([Uint8Array.from(atob(\''
      + zipPackages.one.toString('base64') + '\'),c=>c.charCodeAt(0))]));a.click()">Download</button></main>';
    else if (url.pathname === '/customize/skills/two') body = '<main><h1>Skill two</h1><button aria-label="More options" onclick="this.insertAdjacentHTML(\'afterend\',\'<a download href=/downloads/two.zip>Download</a>\');this.remove()">…</button></main>';
    else if (url.pathname === '/downloads/two.zip') return route.fulfill({ status: 200, contentType: 'application/zip', body: zipPackages.two });
    else if (url.pathname === '/customize/skills/blocked') body = '<main><a download href="/downloads/blocked.zip">Download</a></main>';
    else if (url.pathname === '/downloads/blocked.zip') { status = 403; body = 'Denied'; }
    await route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
  });
  source = await context.newPage(); await source.goto('https://claude.ai/chat/source');
});
after(async () => { await browser?.close(); if (root) await rm(root, { recursive: true, force: true }); });
const localOptions = { home: null, env: {}, include_plugins: true };
function opts(extra = {}) { return { ...localOptions, home, cwd: project, ...extra }; }
async function attach() {
  const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); await page.goto(source.url());
  return new AttachedContext(page, () => page.close(), { method: 'test-existing-browser' });
}

test('Codex discovers modern, legacy, project and plugin skills, excluding bundled system skills by default', async () => {
  const found = await collectLocalSkills(opts({ source: 'codex' }));
  assert.deepEqual(found.skills.map(skill => skill.name).sort(), ['legacy', 'modern', 'plugin-skill', 'project-skill']);
  const included = await collectLocalSkills(opts({ source: 'codex', include_system: true }));
  assert.ok(included.skills.some(skill => skill.name === 'builtin'));
  const withoutPlugins = await collectLocalSkills(opts({ source: 'codex', include_plugins: false }));
  assert.ok(!withoutPlugins.skills.some(skill => skill.name === 'plugin-skill'));
});
test('Claude Code and explicit skill roots are discovered independently of account authentication', async () => {
  const claude = await collectLocalSkills(opts({ source: 'claude-code' }));
  assert.deepEqual(claude.skills.map(skill => skill.name), ['claude-local']);
  const custom = await discoverSkillRoots({ source: 'codex', directories: [join(home, '.agents/skills')] });
  assert.equal(custom.roots.length, 1); assert.equal(custom.roots[0].scope, 'explicit');
});
test('local ZIP packages retain every instruction, binary asset and executable bit without copying account credentials', async () => {
  const result = await exportLocalSkills(opts({ source: 'all', out: join(root, 'local-archive') }));
  assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 5);
  const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
  for (const entry of manifest.skills) {
    const files = validateSkillZip(await readFile(join(result.out, entry.archive)));
    assert.equal(files.length, 3);
    assert.ok(entry.files.find(file => file.path === 'scripts/run.sh').executable);
  }
  const check = await exec('python3', ['-c',
    'import zipfile,io,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; p=zipfile.ZipFile(io.BytesIO(z.read(next(n for n in z.namelist() if n.endswith(".zip"))))); assert p.testzip() is None; assert any(p.read(n)==bytes([0,255,17,2]) for n in p.namelist() if n.endswith(".bin")); assert all("auth.json" not in n for n in z.namelist()); print("ZIP verified")', result.zip.path]);
  assert.match(check.stdout, /ZIP verified/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SKILL_INSTRUCTIONS_|ACCOUNT_CREDENTIALS/);
});
test('linked skill folders work but links to files outside a skill are reported instead of copying them', async () => {
  const directory = join(root, 'symlinks'); await mkdir(directory);
  await symlink(join(home, '.agents/skills/modern'), join(directory, 'linked'));
  const found = await collectLocalSkills({ source: 'codex', directories: [directory] }); assert.equal(found.skills.length, 1);
  await symlink(join(home, '.codex/auth.json'), join(found.skills[0].resolved, 'outside.json'));
  try {
    const captured = await readSkillFiles(found.skills[0]);
    assert.ok(captured.issues.some(issue => issue.reason === 'external_symlink'));
    assert.ok(!captured.files.some(file => file.name === 'outside.json'));
  } finally { await rm(join(found.skills[0].resolved, 'outside.json')); }
});
test('local size limits and excluded local configs produce partial packages with explicit issues', async () => {
  const directory = join(root, 'limited'); await skill(directory);
  await writeFile(join(directory, '.env'), 'DO_NOT_COPY_LOCAL_SECRET');
  const item = { resolved: directory, definition: 'SKILL.md' };
  const captured = await readSkillFiles(item, { max_bytes: Buffer.byteLength(definition('test')) + 4 });
  assert.ok(captured.issues.some(issue => issue.reason === 'excluded_local_config_or_cache'));
  assert.ok(captured.issues.some(issue => issue.reason === 'skill_size_limit'));
  assert.ok(!captured.files.some(file => file.name === '.env'));
});
test('web skills preserve original ZIPs from Blob download and observed same-origin links, without reading chats', async () => {
  const from = requests.length;
  const result = await exportSkills({ source: 'claude-web', out: join(root, 'web'), attach, wait_ms: 5, max_scrolls: 12, download_timeout: 2000 });
  const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
  assert.equal(result.phase, 'complete', JSON.stringify({ result, failures: manifest.skills.filter(skill => skill.status === 'failed'), pageErrors })); assert.equal(result.counts.saved, 2);
  for (const entry of manifest.skills) {
    const original = entry.name.endsWith('one') ? zipPackages.one : zipPackages.two;
    assert.deepEqual(await readFile(join(result.out, entry.archive)), original);
    assert.equal(entry.files.length, 3);
  }
  assert.ok(requests.slice(from).every(request => request.method === 'GET'));
  assert.ok(requests.slice(from).every(request => !/\/backend-api\//.test(request.url)));
  assert.equal(source.isClosed(), false); assert.equal(source.url(), 'https://claude.ai/chat/source');
  assert.equal(context.pages().length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SKILL_INSTRUCTIONS_/);
});
test('a web download denial stops later skills while already saved packages remain available', async () => {
  const isolated = await browser.newContext(); await isolated.setOffline(true);
  const reads = [];
  await isolated.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname; reads.push(path);
    const body = path === '/customize/skills' ? '<main><a href="/customize/skills/blocked">Blocked</a><a href="/customize/skills/later">Later</a></main>'
      : '<main><a download href="/blocked.zip">Download</a></main>';
    await route.fulfill({ status: path === '/blocked.zip' ? 403 : 200, contentType: 'text/html', body });
  });
  try {
    const result = await exportSkills({ source: 'claude-web', out: join(root, 'blocked-web'), wait_ms: 5, max_scrolls: 12,
      attach: async () => { const page = await isolated.newPage(); return new AttachedContext(page, () => page.close(), {}); } });
    assert.equal(result.phase, 'needs_review'); assert.equal(result.counts.failed, 1);
    assert.ok(!reads.includes('/customize/skills/later'));
    assert.equal(reads.filter(path => path === '/blocked.zip').length, 1);
  } finally { await isolated.close(); }
});
test('unavailable web access still produces a usable archive of local Codex and Claude Code skills', async () => {
  const result = await exportSkills(opts({ source: 'all', out: join(root, 'mixed'), attach: async () => { const error = new Error('No source tab'); error.code = 'no_source_tab'; throw error; } }));
  assert.equal(result.phase, 'needs_review'); assert.equal(result.counts.saved, 5);
  assert.ok(result.issues.some(issue => issue.source === 'claude-web' && issue.reason === 'no_source_tab'));
  assert.ok((await readFile(result.zip.path)).length > 0);
});
test('ZIP validation rejects HTML, corrupt bytes, traversal and packages without SKILL.md', async () => {
  assert.throws(() => validateSkillZip(Buffer.from('<html>Login</html>')));
  const corrupt = Buffer.from(zipPackages.one); corrupt[50] ^= 1;
  assert.throws(() => validateSkillZip(corrupt));
  const plain = Buffer.from(await makeZip([{ name: 'no-skill.txt', content: 'text' }]).arrayBuffer());
  assert.throws(() => validateSkillZip(plain), /SKILL.md/);
  const traversal = Buffer.from(zipPackages.one);
  const original = Buffer.from('one/SKILL.md'); const malicious = Buffer.from('../SKILL.md');
  let at = traversal.indexOf(original); malicious.copy(traversal, at); at = traversal.indexOf(original, at + original.length); malicious.copy(traversal, at);
  assert.throws(() => validateSkillZip(traversal), /имя/);
});
test('production skills CLI is noninteractive and returns metadata rather than skill instructions', async () => {
  const result = await exec(process.execPath, [resolve(import.meta.dirname, '../agent.mjs'), 'skills', '--provider', 'codex', '--skills-dir', join(home, '.agents/skills'), '--out', join(root, 'cli')]);
  const parsed = JSON.parse(result.stdout); assert.equal(parsed.phase, 'complete'); assert.equal(parsed.counts.saved, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SKILL_INSTRUCTIONS_|ACCOUNT_CREDENTIALS/);
});
test('real MCP starts a Skills job, polls its metadata and produces a valid local archive', async () => {
  const client = new Client({ name: 'skills-test', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '../mcp.mjs')], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const opened = await client.callTool({ name: 'start_skills_export', arguments: { source: 'codex', directories: [join(home, '.agents/skills')], out: join(root, 'mcp') } });
    assert.ok(!opened.isError, opened.content?.[0]?.text);
    let result = opened.structuredContent; const started = Date.now();
    while (!['complete', 'needs_review', 'failed', 'empty'].includes(result.phase) && Date.now() - started < 10000) {
      await new Promise(resolve => setTimeout(resolve, 20));
      result = (await client.callTool({ name: 'get_skills_export_status', arguments: { job_id: result.job_id } })).structuredContent;
    }
    assert.equal(result.phase, 'complete'); assert.equal(result.counts.saved, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SKILL_INSTRUCTIONS_/);
    assert.ok(result.zip.path.endsWith('skills-backup.zip'));
  } finally { await client.close(); }
});
test('a stopped skill export packs its saved portion and reports a pause', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await exportSkills(opts({ source: 'local', out: join(root, 'stopped'), signal: controller.signal }));
  assert.equal(result.phase, 'paused'); assert.equal(result.stop_reason, 'user_requested'); assert.equal(result.counts.saved, 0);
  assert.ok((await readdir(result.out)).includes('skills-backup.zip'));
});

test('repeating a backup preserves the previous ZIP and an output inside a source skill is rejected', async () => {
  const directory = join(root, 'repeat');
  const options = { source: 'codex', directories: [join(home, '.agents/skills')], out: directory };
  const first = await exportLocalSkills(options); const bytes = await readFile(first.zip.path);
  const next = await exportLocalSkills(options);
  assert.notEqual(next.zip.path, first.zip.path); assert.deepEqual(await readFile(first.zip.path), bytes);
  const nested = await exportLocalSkills({ ...options, out: join(home, '.agents/skills/modern/backup') });
  assert.equal(nested.counts.failed, 1); assert.equal(nested.counts.saved, 0);
  await rm(join(home, '.agents/skills/modern/backup'), { recursive: true, force: true });
});
test('delayed web controls are awaited and a foreign download never receives browser credentials', async () => {
  const isolated = await browser.newContext(); await isolated.setOffline(true); const visited = [];
  await isolated.route('**/*', async route => {
    const url = new URL(route.request().url()); visited.push(url.href);
    let body;
    if (url.pathname === '/customize/skills') body = '<main><a href="/customize/skills/late">Late</a><a href="/customize/skills/foreign">Foreign</a></main>';
    else if (url.pathname.endsWith('/late')) body = '<main id="content">Loading</main><script>setTimeout(()=>{document.getElementById("content").innerHTML=\'<a download href="/late.zip">Download</a>\'},200)</script>';
    else if (url.pathname === '/late.zip') return route.fulfill({ status: 200, contentType: 'application/zip', body: zipPackages.one });
    else body = '<main><a download href="https://evil.example/private.zip">Download</a></main>';
    await route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  try {
    const result = await exportSkills({ source: 'claude-web', out: join(root, 'web-boundaries'), wait_ms: 5, max_scrolls: 12, download_timeout: 2000,
      attach: async () => { const page = await isolated.newPage(); return new AttachedContext(page, () => page.close(), {}); } });
    assert.equal(result.counts.saved, 1); assert.equal(result.counts.failed, 1); assert.equal(result.phase, 'needs_review');
    assert.ok(!visited.some(url => url.startsWith('https://evil.example/')));
    const manifest = JSON.parse(await readFile(result.manifest_file, 'utf8'));
    assert.ok(manifest.skills.some(skill => skill.error === 'cross_origin_skill_download'));
  } finally { await isolated.close(); }
});
