import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyZip(out, zip) {
  if (!zip?.path || dirname(resolve(zip.path)) !== resolve(out)) return { verified: false, reason: 'archive_missing_or_wrong_path' };
  try {
    const info = await lstat(zip.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== zip.bytes) return { verified: false, reason: 'archive_size_or_type_changed' };
    const digest = await fileHash(zip.path);
    if (digest !== zip.sha256) return { verified: false, reason: 'archive_checksum_mismatch' };
    return { verified: !zip.integrity_issues?.length, sha256: digest, bytes: info.size,
      ...(zip.integrity_issues?.length ? { reason: 'export_file_integrity_issues' } : {}) };
  } catch (error) { return { verified: false, reason: error.code || 'archive_unreadable' }; }
}
