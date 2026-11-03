import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ExportSession } from './session.mjs';
import { discoverPage } from './dom.mjs';
import { chatUrl } from './engine.mjs';
import { atomicWrite, sha256 } from './archive.mjs';
import { verifyZip } from './verification.mjs';
import { TOOL_VERSION } from './version.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function verifyProviders({ provider = 'all', out, browser = 'chrome', cdp_endpoint, source_tab, timeout_ms = 180000,
  sessionFactory = () => new ExportSession() } = {}) {
  if (!['all', 'chatgpt', 'claude'].includes(provider)) throw new Error('verify --provider: all, chatgpt или claude.');
  let directory = resolve(out || join(homedir(), 'Downloads/chat-rescue/checks', Date.now() + '-' + randomUUID().slice(0, 8)));
  const used = await Promise.all(['verification-report.json', 'chatgpt/run.json', 'claude/run.json'].map(async path => { try { await lstat(join(directory, path)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }));
  if (used.some(Boolean)) directory = join(directory, 'run-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { version: 1, tool_version: TOOL_VERSION, kind: 'existing_browser_chat_roundtrip', created_at: new Date().toISOString(),
    requested_providers: provider === 'all' ? ['chatgpt', 'claude'] : [provider], providers: {}, verified_all: false,
    all_account_chats_verified: false, report_file: join(directory, 'verification-report.json') };
  for (const service of report.requested_providers) {
    const session = sessionFactory(); let result;
    try {
      await session.open({ provider: service, workspace: 'verification', out: join(directory, service), connection: 'existing', auto_start: false, browser, cdp_endpoint, source_tab });
      const inspected = await session.inspect(); let target = inspected.current_chat;
      let selection = 'current_chat';
      if (!target) {
        const visible = await session.page.evaluate(discoverPage, { provider: service });
        target = visible.links.map(link => chatUrl(link.url, service)).find(Boolean); selection = 'first_visible_history_link';
      }
      if (!target) { const error = new Error('Нет открытого чата или доступной ссылки истории.'); error.code = 'verification_chat_required'; throw error; }
      await session.start({ mode: 'urls', urls: [target.url], limit: 1, delay_ms: 1000 });
      const started = Date.now();
      while (session.job && Date.now() - started < timeout_ms) await sleep(100);
      if (session.job) { await session.stop(); await session.job; const error = new Error('Проверка превысила отведённое время.'); error.code = 'verification_timeout'; throw error; }
      const status = await session.status();
      const manifest = JSON.parse(await readFile(status.manifest_file, 'utf8'));
      const entry = manifest.chats[target.id];
      const archive = await verifyZip(status.out, status.zip);
      let contentVerified = false, roles = [], messageCount = 0, method = null;
      if (entry?.jsonFile && entry.markdownFile) {
        const json = await readFile(join(status.out, entry.jsonFile)), md = await readFile(join(status.out, entry.markdownFile));
        const chat = JSON.parse(json);
        roles = [...new Set(chat.messages.map(message => ['user', 'assistant', 'system', 'developer', 'tool'].includes(message.role) ? message.role : 'unknown'))]; messageCount = chat.messages.length; method = chat.method;
        contentVerified = chat.id === target.id && chat.provider === service && roles.includes('user') && roles.includes('assistant')
          && chat.messages.some(message => message.role === 'user' && (message.text || message.markdown || '').trim())
          && chat.messages.some(message => message.role === 'assistant' && (message.text || message.markdown || '').trim())
          && sha256(json) === entry.jsonSha256 && sha256(md) === entry.markdownSha256 && md.length > 0;
      }
      result = { verified: status.phase === 'complete' && status.counts.saved === 1 && !status.counts.partial && !status.counts.failed && contentVerified && archive.verified,
        phase: status.phase, counts: status.counts, selection, chat_hash: sha256(target.id).slice(0, 12), message_count: messageCount, roles, method,
        content_files_verified: contentVerified, archive_verification: archive, zip: status.zip?.path || null, diagnostics_file: status.diagnostics_file,
        ...(!contentVerified || status.phase !== 'complete' ? { failure_code: 'chat_roundtrip_not_complete' } : {}) };
    } catch (error) { result = { verified: false, failure_code: error.code || 'verification_failed', message: error.message }; }
    finally { await session.close().catch(() => {}); }
    report.providers[service] = result;
    await atomicWrite(report.report_file, JSON.stringify(report, null, 2));
  }
  report.verified_all = report.requested_providers.every(service => report.providers[service]?.verified === true);
  report.next_action = report.verified_all ? 'Проверен один непустой чат каждого запрошенного сервиса. Можно запускать общий сбор; полнота аккаунта отдельно не подтверждена.'
    : 'Живой сбор обоих сервисов не подтверждён. Посмотрите failure_code; используйте уже открытые авторизованные вкладки и разрешённое управление браузером.';
  await atomicWrite(report.report_file, JSON.stringify(report, null, 2));
  return report;
}
