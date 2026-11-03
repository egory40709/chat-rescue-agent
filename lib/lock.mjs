import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './archive.mjs';

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function acquireLock(out) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const path = join(out, '.agent-lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); }
    catch { throw new Error('Архив занят или lock не распознан. Не удаляйте его, пока другой запуск работает.'); }
    if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error('Этот архив уже обрабатывается другим процессом.');
    // Preserve the old lock as evidence; never kill a process or remove a browser lock.
    await rename(path, path + '-stale-' + randomUUID());
    await mkdir(path, { mode: 0o700 });
  }
  const id = randomUUID();
  await atomicWrite(join(path, 'owner.json'), JSON.stringify({ id, pid: process.pid, createdAt: new Date().toISOString() }));
  return async () => {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (owner.id !== id) throw new Error('Владелец lock изменился; чужой lock сохранён.');
    await rm(path, { recursive: true });
  };
}
