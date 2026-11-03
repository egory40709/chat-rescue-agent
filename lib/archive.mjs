import { PROVIDERS } from './engine.mjs';
import { toMarkdown } from './format.mjs';
export { PROVIDERS, chatUrl, mergeWindow } from './engine.mjs';
export { toMarkdown } from './format.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const slug = value => String(value).normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';

export async function atomicWrite(path, data) {
  const temp = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}

export async function openArchive(out, provider, workspace) {
  await mkdir(join(out, 'chats'), { recursive: true, mode: 0o700 });
  let manifest;
  try { manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('manifest.json повреждён: используйте новую папку; старый архив сохранён.');
    manifest = { version: 1, provider, workspace, createdAt: new Date().toISOString(), coverage: 'unverified', chats: Object.create(null), discoveries: [] };
  }
  if (manifest.version !== 1 || manifest.provider !== provider || manifest.workspace !== workspace || !manifest.chats || typeof manifest.chats !== 'object' || Array.isArray(manifest.chats) || !Array.isArray(manifest.discoveries)) {
    throw new Error('Папка принадлежит другому сервису/пространству или формату. Укажите отдельный --out.');
  }
  Object.setPrototypeOf(manifest.chats, null);
  return manifest;
}

export async function saveManifest(out, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await atomicWrite(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const counts = {};
  for (const entry of Object.values(manifest.chats)) counts[entry.status] = (counts[entry.status] || 0) + 1;
  const rows = ['# Сохранённые чаты', '', 'Сервис: ' + manifest.provider, '', 'Пространство (выбрано сотрудником): ' + manifest.workspace, '',
    '**Полнота истории аккаунта не подтверждена.** Файлы вложений и другие ветки браузерный сбор не сохраняет.', '',
    'Статусы: ' + Object.entries(counts).map(([status, count]) => status + ': ' + count).join(', '), ''];
  for (const [id, entry] of Object.entries(manifest.chats)) {
    const label = String(entry.title || id).replace(/[\[\]\r\n]/g, ' ');
    rows.push('- ' + entry.status + ': ' + (entry.markdownFile ? '[' + label + '](' + entry.markdownFile + ')' : label));
    if (entry.error) rows.push('  Ошибка: ' + entry.error.replace(/[\r\n]/g, ' '));
  }
  await atomicWrite(join(out, 'INDEX.md'), rows.join('\n') + '\n');
}

export async function savedIntact(out, entry) {
  if (!entry || entry.status !== 'saved') return false;
  // Do not follow arbitrary file paths from a corrupt manifest.
  if (![entry.jsonFile, entry.markdownFile].every(path => /^chats\/[\w-]+\.(json|md)$/.test(path || ''))) return false;
  try {
    const [json, markdown] = await Promise.all([readFile(join(out, entry.jsonFile)), readFile(join(out, entry.markdownFile))]);
    return sha256(json.toString()) === entry.jsonSha256 && sha256(markdown.toString()) === entry.markdownSha256;
  } catch { return false; }
}

export async function saveChat(out, manifest, chat) {
  // Filenames use a digest, never a title or an identifier supplied by a website.
  const json = JSON.stringify(chat, null, 2);
  const markdown = toMarkdown(chat);
  const base = sha256(chat.id).slice(0, 24) + '-' + sha256(json).slice(0, 24);
  const jsonFile = 'chats/' + base + '.json';
  const markdownFile = 'chats/' + base + '.md';
  await atomicWrite(join(out, jsonFile), json);
  await atomicWrite(join(out, markdownFile), markdown);
  const previous = manifest.chats[chat.id];
  const revisions = previous?.revisions || [];
  if (previous?.jsonFile && previous.jsonFile !== jsonFile) revisions.push({ ...previous, revisions: undefined });
  manifest.chats[chat.id] = {
    status: chat.warnings?.length ? 'partial' : 'saved', title: chat.title, url: chat.url,
    jsonFile, markdownFile, jsonSha256: sha256(json), markdownSha256: sha256(markdown),
    messageCount: chat.messages.length, capturedAt: chat.capturedAt, warnings: chat.warnings || [], revisions,
    sourceRecordSha256: chat.sourceRecordSha256,
  };
  await saveManifest(out, manifest);
}

export async function withLock(out, callback) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const path = join(out, '.running');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Этот архив уже открыт. Если прошлый процесс завершился аварийно, удалите только папку ' + path);
    throw error;
  }
  try { return await callback(); }
  finally { const { rmdir } = await import('node:fs/promises'); await rmdir(path); }
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.type === 'text' && typeof value.content === 'string') return value.content;
    return '[Нетекстовый блок: ' + String(value.type || value.content_type || 'unknown') + '; исходник сохранён в JSON]';
  }
  return '';
}

export function normalizeOfficial(raw, provider) {
  const id = String(provider === 'chatgpt' ? raw.conversation_id || raw.id || raw.uuid || '' : raw.conversation_uuid || raw.uuid || raw.id || '');
  if (!id) throw new Error('В записи нет идентификатора диалога.');
  const messages = [];
  const warnings = [];
  if (provider === 'chatgpt') {
    const mapping = raw.mapping;
    if (!mapping || typeof mapping !== 'object') throw new Error('В ChatGPT JSON отсутствует mapping.');
    let node = mapping[raw.current_node];
    const branch = [];
    const seen = new Set();
    while (node) {
      if (seen.has(node)) throw new Error('Обнаружен цикл в дереве сообщений.');
      seen.add(node);
      if (node.message) branch.push(node.message);
      if (node.parent && !mapping[node.parent]) warnings.push('Отсутствует родительский узел ' + node.parent);
      node = node.parent ? mapping[node.parent] : null;
    }
    if (!branch.length) throw new Error('Не найдена текущая ветка ChatGPT; исходный JSON не изменён.');
    for (const message of branch.reverse()) {
      messages.push({ role: message.author?.role || 'unknown', text: textOf(message.content?.parts || message.content), id: message.id });
    }
  } else {
    if (!Array.isArray(raw.chat_messages)) throw new Error('В Claude JSON отсутствует chat_messages.');
    let ordered = raw.chat_messages;
    const hasParents = ordered.some(message => Object.hasOwn(message, 'parent_message_uuid'));
    let leaf = raw.current_leaf_message_uuid;
    const byId = new Map(ordered.map(message => [message.uuid || message.id, message]));
    if ((leaf || hasParents) && (byId.has(undefined) || byId.size !== ordered.length)) throw new Error('Неоднозначные идентификаторы сообщений Claude.');
    if (!leaf && hasParents && ordered.length) {
      const parents = new Set(ordered.map(message => message.parent_message_uuid).filter(parent => byId.has(parent)));
      const leaves = ordered.filter(message => !parents.has(message.uuid || message.id));
      if (leaves.length !== 1) { const error = new Error('В Claude JSON несколько веток, но текущая ветка не указана.'); error.code = 'claude_branch_unresolved'; throw error; }
      leaf = leaves[0].uuid || leaves[0].id;
    }
    if (leaf) {
      if (ordered.length > 1 && !ordered.some(message => byId.has(message.parent_message_uuid))) { const error = new Error('В Claude JSON нет связей для восстановления выбранной ветки.'); error.code = 'claude_branch_unresolved'; throw error; }
      if (!byId.has(leaf)) { const error = new Error('Текущий leaf Claude отсутствует в chat_messages.'); error.code = 'claude_branch_unresolved'; throw error; }
      const chain = [], seen = new Set(); let message = byId.get(leaf);
      while (message) {
        const messageId = message.uuid || message.id;
        if (seen.has(messageId)) throw new Error('Цикл в дереве сообщений Claude.');
        seen.add(messageId); chain.push(message);
        const parent = message.parent_message_uuid;
        if (!parent || parent === '00000000-0000-0000-0000-000000000000') break;
        if (!byId.has(parent)) { warnings.push('В Claude JSON отсутствует родительский узел; начало ветки не подтверждено.'); break; }
        message = byId.get(parent);
      }
      if (!raw.current_leaf_message_uuid && chain.length !== ordered.length) { const error = new Error('Без текущего leaf Claude нельзя выбрать одну из веток.'); error.code = 'claude_branch_unresolved'; throw error; }
      ordered = chain.reverse();
    }
    for (const message of ordered) {
      const role = message.sender || message.role || 'unknown';
      if (message.truncated === true) warnings.push('В исходном сообщении Claude указан truncated=true; полнота текста не подтверждена.');
      messages.push({ role: role === 'human' ? 'user' : role,
        text: textOf(message.content) || message.text || '', id: message.uuid || message.id });
    }
  }
  return {
    id, provider, title: raw.title || raw.name || id,
    url: PROVIDERS[provider].origin + (provider === 'chatgpt' ? '/c/' : '/chat/') + encodeURIComponent(id),
    capturedAt: new Date().toISOString(), method: 'official-json-conversion', messages, warnings, raw,
    sourceRecordSha256: sha256(raw),
    limitations: ['Markdown показывает текущую ветку; исходная запись со всеми имеющимися ветками сохранена в JSON', 'Бинарные вложения не копируются; сохраните оригинальный ZIP целиком'],
  };
}
