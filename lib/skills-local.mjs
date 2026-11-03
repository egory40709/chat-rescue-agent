import { readdir, readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { makeZip } from './zip.mjs';
import { atomicWrite, sha256, slug } from './archive.mjs';
import { acquireLock } from './lock.mjs';

const exec = promisify(execFile);
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const within = (root, target) => target === root || target.startsWith(root + sep);
const excluded = name => ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', 'auth.json', 'credentials.json'].includes(name)
  || (name.startsWith('.env') && !['.env.example', '.env.template', '.env.sample'].includes(name));

export async function discoverSkillRoots({ source = 'all', cwd = process.cwd(), home = homedir(), env = process.env, include_system = false, include_plugins = true, directories = [] } = {}) {
  if (!['all', 'codex', 'claude-code'].includes(source)) throw new Error('source: all, codex или claude-code.');
  const roots = [], issues = [];
  const add = (path, provider, scope) => roots.push({ path: resolve(path), source: provider, scope });
  if (directories.length) {
    for (const path of directories) add(path, source === 'all' ? 'custom' : source, 'explicit');
    return { roots, issues };
  }
  const codex = resolve(env.CODEX_HOME || join(home, '.codex'));
  if (source !== 'claude-code') {
    add(join(home, '.agents/skills'), 'codex', 'user');
    add(join(codex, 'skills'), 'codex', 'user');
    if (include_system) add('/etc/codex/skills', 'codex', 'admin');
  }
  if (source !== 'codex') add(join(home, '.claude/skills'), 'claude-code', 'user');
  let repo;
  try { repo = (await exec('git', ['-C', resolve(cwd), 'rev-parse', '--show-toplevel'], { timeout: 5000 })).stdout.trim(); } catch { /* A project need not be a Git repository. */ }
  let current = resolve(cwd);
  for (;;) {
    if (source !== 'claude-code') { add(join(current, '.agents/skills'), 'codex', 'project'); add(join(current, '.codex/skills'), 'codex', 'project'); }
    if (source !== 'codex') add(join(current, '.claude/skills'), 'claude-code', 'project');
    if (!repo || current === repo || dirname(current) === current) break;
    current = dirname(current);
  }
  if (include_plugins) {
    const caches = [];
    if (source !== 'claude-code') caches.push({ path: join(codex, 'plugins/cache'), source: 'codex' });
    if (source !== 'codex') caches.push({ path: join(home, '.claude/plugins/cache'), source: 'claude-code' });
    const scan = async (path, provider, depth = 0) => {
      if (depth > 8) { issues.push({ path, reason: 'plugin_scan_depth_limit' }); return; }
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') issues.push({ path, reason: error.code || 'unreadable' }); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (excluded(entry.name) || entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;
        const child = join(path, entry.name);
        if (entry.name === 'skills') add(child, provider, 'plugin');
        else await scan(child, provider, depth + 1);
      }
    };
    for (const cache of caches) await scan(cache.path, cache.source);
  }
  return { roots: [...new Map(roots.map(root => [root.source + ':' + root.path, root])).values()], issues };
}

export async function collectLocalSkills(options = {}) {
  const { roots, issues } = await discoverSkillRoots(options);
  const skills = [], seen = new Set();
  const inspect = async (path, root) => {
    let resolved;
    try { resolved = await realpath(path); } catch (error) { issues.push({ path, reason: error.code || 'unreadable' }); return; }
    const key = root.source + ':' + resolved;
    if (seen.has(key)) return;
    const definition = (await exists(join(resolved, 'SKILL.md'))) ? 'SKILL.md' : (await exists(join(resolved, 'skill.md'))) ? 'skill.md' : null;
    if (!definition) return;
    seen.add(key); skills.push({ ...root, path, resolved, name: basename(path), definition });
  };
  for (const root of roots) {
    if (!await exists(root.path)) continue;
    if (await exists(join(root.path, 'SKILL.md')) || await exists(join(root.path, 'skill.md'))) { await inspect(root.path, root); continue; }
    let entries;
    try { entries = await readdir(root.path, { withFileTypes: true }); }
    catch (error) { issues.push({ path: root.path, reason: error.code || 'unreadable' }); continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.system' && options.include_system) {
        for (const child of await readdir(join(root.path, entry.name))) await inspect(join(root.path, entry.name, child), { ...root, scope: 'system' });
      } else if (!entry.name.startsWith('.') && !excluded(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) await inspect(join(root.path, entry.name), root);
    }
  }
  return { roots, skills, issues };
}

export async function readSkillFiles(skill, { max_bytes = 128 * 1024 * 1024, max_files = 10000 } = {}) {
  const files = [], issues = []; let total = 0;
  const sourceRoot = await realpath(skill.resolved);
  const walk = async (path, logical = '', ancestors = new Set()) => {
    const actual = await realpath(path);
    if (!within(sourceRoot, actual)) { issues.push({ path: logical, reason: 'external_symlink' }); return; }
    const stat = await lstat(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) { issues.push({ path: logical, reason: 'symlink_cycle' }); return; }
      const next = new Set([...ancestors, actual]);
      for (const entry of (await readdir(actual)).sort()) {
        const name = logical ? logical + '/' + entry : entry;
        if (excluded(entry)) { issues.push({ path: name, reason: 'excluded_local_config_or_cache' }); continue; }
        try { await walk(join(actual, entry), name, next); }
        catch (error) { issues.push({ path: name, reason: error.code || 'unreadable' }); }
      }
    } else if (stat.isFile()) {
      if (files.length >= max_files || total + stat.size > max_bytes) { issues.push({ path: logical, reason: 'skill_size_limit' }); return; }
      const content = await readFile(actual);
      if (total + content.length > max_bytes) { issues.push({ path: logical, reason: 'skill_size_limit' }); return; }
      files.push({ name: logical, content, executable: !!(stat.mode & 0o111) }); total += content.length;
    } else issues.push({ path: logical, reason: 'unsupported_file_type' });
  };
  await walk(skill.resolved);
  if (!files.some(file => file.name === skill.definition)) throw new Error('Не удалось прочитать SKILL.md: пакет не сохранён.');
  return { files, issues, bytes: total };
}

export async function createSkillsArchive({ out, source = 'all' } = {}) {
  let directory = resolve(out || join(homedir(), 'Downloads/chat-rescue/skills', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)));
  if (await exists(join(directory, 'manifest.json')) || await exists(join(directory, 'skills-backup.zip'))) directory = join(directory, 'run-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory);
  const manifest = { version: 1, source, created_at: new Date().toISOString(), coverage: 'unverified', skills: [], issues: [], roots: [] };
  const entries = []; let packageBytes = 0;
  return {
    out: directory, manifest,
    async add({ name, source, origin, content, files = [], issues = [] }) {
      if (packageBytes + content.length > 256 * 1024 * 1024) throw new Error('Общий архив Skills достиг предела 256 МБ; сохраните оставшееся отдельным запуском.');
      const folder = slug(name);
      const archivePath = 'skills/' + source + '/' + folder + '-' + sha256(origin).slice(0, 12) + '.zip';
      await mkdir(dirname(join(directory, archivePath)), { recursive: true, mode: 0o700 });
      await atomicWrite(join(directory, archivePath), content);
      entries.push({ name: archivePath, content }); packageBytes += content.length;
      manifest.skills.push({ name, source, origin, status: issues.length ? 'partial' : 'saved', archive: archivePath,
        sha256: sha256(content), bytes: content.length, files, issues });
      await atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    },
    async finish() {
      try {
        const counts = { saved: 0, partial: 0, failed: 0 };
        for (const skill of manifest.skills) counts[skill.status]++;
        const report = JSON.stringify(manifest, null, 2);
        const index = ['# Архив Skills', '', 'Сохранены пакеты Skills с инструкциями и доступными файлами.',
          'Код Skills при сборе не выполняется. Секреты аккаунтов и конфиги MCP не переносятся.',
          'Полнота облачного аккаунта не подтверждена; смотрите manifest.json и issues.', '',
          ...manifest.skills.map(skill => '- ' + skill.status + ': ' + (skill.archive ? '[' + skill.name.replace(/[\[\]\r\n]/g, ' ') + '](' + skill.archive + ')' : skill.name)), '',
          'Для локального Codex/Claude Code распакуйте отдельный ZIP в каталог skills.',
          'Для Claude Web загружайте отдельный ZIP навыка; общий ZIP — архив резервной копии.', ''].join('\n');
        await atomicWrite(join(directory, 'manifest.json'), report); await atomicWrite(join(directory, 'INDEX.md'), index);
        const bytes = Buffer.from(await makeZip([...entries, { name: 'manifest.json', content: report }, { name: 'INDEX.md', content: index }]).arrayBuffer());
        const path = join(directory, 'skills-backup.zip'); await atomicWrite(path, bytes);
        return { out: directory, zip: { path, sha256: sha256(bytes), bytes: bytes.length }, counts, issues: manifest.issues,
          manifest_file: join(directory, 'manifest.json'), index_file: join(directory, 'INDEX.md'), coverage: 'unverified',
          phase: counts.failed || counts.partial || manifest.issues.length ? 'needs_review' : counts.saved ? 'complete' : 'empty' };
      } finally { await release(); }
    },
  };
}

export async function collectLocalIntoArchive(archive, options = {}) {
  const result = await collectLocalSkills(options);
  archive.manifest.roots = result.roots; archive.manifest.issues.push(...result.issues);
  for (const skill of result.skills) {
    if (options.signal?.aborted) { archive.manifest.issues.push({ source: 'local', reason: 'user_requested' }); break; }
    options.onProgress?.({ phase: 'exporting_local_skills', current: skill.name, discovered: result.skills.length });
    try {
      if (within(skill.resolved, await realpath(archive.out))) throw new Error('Папка результата не должна находиться внутри исходного Skill.');
      const captured = await readSkillFiles(skill, options);
      const name = slug(skill.name);
      const bytes = Buffer.from(await makeZip(captured.files.map(file => ({ ...file, name: name + '/' + file.name }))).arrayBuffer());
      await archive.add({ name: skill.name, source: skill.source, origin: skill.path, content: bytes,
        files: captured.files.map(file => ({ path: file.name, bytes: file.content.length, sha256: sha256(file.content), executable: file.executable })), issues: captured.issues });
    } catch (error) { archive.manifest.skills.push({ name: skill.name, source: skill.source, origin: skill.path, status: 'failed', error: error.message }); }
  }
  return archive;
}

export async function exportLocalSkills(options = {}) {
  const archive = await createSkillsArchive(options);
  try { await collectLocalIntoArchive(archive, options); }
  catch (error) { archive.manifest.issues.push({ source: options.source || 'all', reason: error.code || error.message }); }
  return archive.finish();
}
