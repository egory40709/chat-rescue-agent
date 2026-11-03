import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeZip } from '../lib/zip.mjs';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
async function walk(directory) {
  const paths = [];
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Не включать символические ссылки в релиз.');
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}
const paths = ['package.json', 'package-lock.json', 'agent.mjs', 'mcp.mjs', 'README.md', 'QA.md', 'AGENTS.md', 'CLAUDE.md', 'PROMPT.txt', '.gitignore',
  ...await walk('lib'), ...await walk('test'), ...await walk('scripts')];
for (const path of paths.filter(path => path.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', join(root, path)]);
const files = [];
for (const path of paths) files.push({ name: 'chat-rescue-agent/' + path, content: await readFile(join(root, path)), executable: ['agent.mjs', 'mcp.mjs'].includes(path) });
const bytes = Buffer.from(await makeZip(files).arrayBuffer());
const name = 'chat-rescue-agent-' + version + '.zip';
await writeFile(join(root, name), bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(root, 'checksums-' + version + '.txt'), sha256 + '  ' + name + '\n');
console.log(JSON.stringify({ file: join(root, name), files: files.length, bytes: bytes.length, sha256 }, null, 2));
