import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserCandidates } from '../lib/doctor.mjs';
import { discoverCdpEndpoints } from '../lib/existing-browser.mjs';
import { collectLocalSkills } from '../lib/skills-local.mjs';
const exec = promisify(execFile);

test('Windows browser discovery includes per-user, 64-bit and 32-bit Chrome and Edge installations', () => {
  const paths = browserCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' }, chromiumPath: 'C:\\browser\\chrome.exe' });
  assert.equal(paths.chrome[0], 'C:\\Users\\Test User\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(paths.msedge[1], 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(paths.msedge[2], 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
});
test('Windows CDP metadata supports AppData paths with spaces and CRLF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat rescue Windows '));
  try {
    const chrome = join(root, 'Google/Chrome/User Data'); await mkdir(chrome, { recursive: true });
    await writeFile(join(chrome, 'DevToolsActivePort'), '23456\r\n/devtools/browser/windows-test\r\n');
    const urls = await discoverCdpEndpoints({ platform: 'win32', env: { LOCALAPPDATA: root }, home: root });
    assert.equal(urls[0], 'ws://127.0.0.1:23456/devtools/browser/windows-test');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('skill discovery stays inside the Git project when paths contain spaces and non-ASCII names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat rescue проект '));
  const project = join(root, 'project with spaces'), home = join(root, 'fake home');
  try {
    await mkdir(project, { recursive: true }); await exec('git', ['init', project]);
    const local = join(project, '.agents/skills/local'), outside = join(root, '.agents/skills/outside');
    for (const path of [local, outside]) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: fixture\ndescription: test\n---\n'); }
    const found = await collectLocalSkills({ source: 'codex', cwd: project, home, env: {}, include_plugins: false });
    assert.deepEqual(found.skills.map(skill => skill.name), ['local']);
    assert.ok(!found.roots.some(item => item.path === join(root, '.agents/skills')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the Windows CLI starts from built-in PowerShell without changing execution policy', { skip: process.platform !== 'win32' }, async () => {
  const source = '& $env:CHAT_RESCUE_TEST_NODE $env:CHAT_RESCUE_TEST_AGENT doctor; exit $LASTEXITCODE';
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, CHAT_RESCUE_TEST_NODE: process.execPath, CHAT_RESCUE_TEST_AGENT: join(import.meta.dirname, '../agent.mjs') },
  });
  const doctor = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(doctor.platform, 'win32'); assert.equal(doctor.node_ok, true);
  assert.equal(doctor.existing_session_access.macos_native, false);
});
