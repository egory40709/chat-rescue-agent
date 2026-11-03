import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../lib/archive.mjs';

test('Windows sharing violations retry replacement while every reader sees complete JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-rescue-storage-'));
  try {
    const path = join(root, 'run.json'); await writeFile(path, '{"saved":1}');
    let calls = 0; const waits = [];
    await atomicWrite(path, '{"saved":2}', { platform: 'win32',
      renameFile: async (source, target) => {
        assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { saved: 2 });
        assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { saved: 1 });
        if (calls++ < 3) throw Object.assign(new Error('File is being read'), { code: ['EPERM', 'EACCES', 'EBUSY'][calls - 1] });
        return rename(source, target);
      }, pause: async ms => { waits.push(ms); },
    });
    assert.equal(calls, 4); assert.deepEqual(waits, [25, 50, 100]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { saved: 2 });
    assert.deepEqual(await readdir(root), ['run.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('permanent Windows replacement denial is bounded and preserves the previous archive file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-rescue-storage-'));
  try {
    const path = join(root, 'manifest.json'); await writeFile(path, 'previous');
    const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    let calls = 0; const waits = [];
    await assert.rejects(atomicWrite(path, 'new', { platform: 'win32',
      renameFile: async () => { calls++; throw denied; }, pause: async ms => { waits.push(ms); },
    }), error => error === denied);
    assert.equal(calls, 11); assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 1875);
    assert.equal(await readFile(path, 'utf8'), 'previous'); assert.deepEqual(await readdir(root), ['manifest.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-Windows permission errors and disk errors are returned without replacement retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-rescue-storage-'));
  try {
    for (const [platform, code] of [['darwin', 'EPERM'], ['win32', 'ENOSPC']]) {
      const path = join(root, 'file-' + platform); await writeFile(path, 'previous');
      const failure = Object.assign(new Error(code), { code }); let calls = 0;
      await assert.rejects(atomicWrite(path, 'new', { platform,
        renameFile: async () => { calls++; throw failure; }, pause: async () => { assert.fail('Unexpected retry'); },
      }), error => error === failure);
      assert.equal(calls, 1); assert.equal(await readFile(path, 'utf8'), 'previous');
    }
    assert.equal((await readdir(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
