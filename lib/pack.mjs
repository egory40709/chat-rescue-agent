import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeZip } from './zip.mjs';
import { verifyZip } from './verification.mjs';
import { sha256, atomicWrite, saveManifest } from './archive.mjs';

export async function packArchive(out, manifest) {
  await saveManifest(out, manifest);
  const files = [], seen = new Set(), issues = [];
  for (const [id, entry] of Object.entries(manifest.chats)) {
    for (const version of [...(entry.revisions || []), entry]) {
      for (const [path, hash] of [[version.jsonFile, version.jsonSha256], [version.markdownFile, version.markdownSha256]]) {
        if (!path || seen.has(path)) continue;
        if (!/^chats\/[\w-]+\.(json|md)$/.test(path)) throw new Error('В журнале недопустимое имя файла.');
        seen.add(path);
        try {
          const metadata = await lstat(join(out, path));
          if (!metadata.isFile() || metadata.isSymbolicLink()) { issues.push({ id, path, problem: 'unexpected_file_type' }); continue; }
          const bytes = await readFile(join(out, path));
          if (sha256(bytes) !== hash) issues.push({ id, path, problem: 'checksum_mismatch' });
          files.push({ name: path, content: bytes });
        } catch (error) { issues.push({ id, path, problem: error.code || 'unreadable' }); }
      }
    }
  }
  for (const name of ['manifest.json', 'INDEX.md']) files.push({ name, content: await readFile(join(out, name)) });
  try { files.push({ name: 'diagnostics.json', content: await readFile(join(out, 'diagnostics.json')) }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.push({ name: 'EXPORT-ISSUES.json', content: JSON.stringify({ coverage: 'unverified', integrity_issues: issues }, null, 2) });
  const bytes = Buffer.from(await makeZip(files).arrayBuffer());
  const digest = sha256(bytes);
  const path = join(out, 'chat-rescue-' + manifest.provider + '-' + digest.slice(0, 16) + '.zip');
  await atomicWrite(path, bytes);
  const result = { path, sha256: digest, bytes: bytes.length, integrity_issues: issues, coverage: 'unverified' };
  result.verification = await verifyZip(out, result);
  return result;
}
