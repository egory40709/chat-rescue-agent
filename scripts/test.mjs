import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const files = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'test', name));
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
