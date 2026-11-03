const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Standard ZIP, uncompressed, UTF-8. No external library or network dependency.
export function makeZip(files) {
  if (files.length > 65535) throw new Error('Слишком много файлов для одного ZIP. Скачайте архив частями.');
  const chunks = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const file of files) {
    if (file.name.startsWith('/') || file.name.includes('..') || file.name.includes('\\')) throw new Error('Недопустимое имя файла в ZIP.');
    const name = encoder.encode(file.name);
    const bytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    if (bytes.length > 0xffffffff || offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error('Архив превышает 4 ГБ.');
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint16(12, 33, true); // 1980-01-01, a valid deterministic DOS date.
    l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true);
    l.setUint16(26, name.length, true); local.set(name, 30);
    chunks.push(local, bytes);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x0314, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true); c.setUint32(38, ((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, true);
    c.setUint32(42, offset, true); central.set(name, 46);
    directory.push(central); directorySize += central.length;
    offset += local.length + bytes.length;
  }
  if (offset + directorySize + 22 > 0xffffffff) throw new Error('Архив превышает 4 ГБ.');
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}
