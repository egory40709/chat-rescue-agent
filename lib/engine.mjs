import { readPage, discoverPage } from './dom.mjs';
import { observeConversation, sourceProbe, conversationRecord } from './conversation-source.mjs';

// Direct per-conversation reading; never the provider's Settings → Export data flow.
export const EXTRACTION_METHOD = 'ui-conversation-v2';

export const PROVIDERS = {
  chatgpt: { origin: 'https://chatgpt.com', start: 'https://chatgpt.com/' },
  claude: { origin: 'https://claude.ai', start: 'https://claude.ai/recents' },
};
export function chatUrl(input, provider) {
  let url;
  try { url = new URL(input, PROVIDERS[provider].origin); } catch { return null; }
  if (url.origin !== PROVIDERS[provider].origin || url.username || url.password) return null;
  const match = provider === 'chatgpt' ? url.pathname.match(/\/(?:c)\/([\w-]{1,160})\/?$/)
    : url.pathname.match(/^\/chat\/([\w-]{1,160})\/?$/);
  if (!match) return null;
  return { id: match[1], url: url.origin + url.pathname.replace(/\/$/, '') };
}

export function mergeWindow(existing, incoming) {
  const key = m => JSON.stringify([m.domId || '', m.role, m.markdown, m.text]);
  const a = existing.map(key);
  const b = incoming.map(key);
  if (!b.length) return { messages: existing, gap: false };
  if (!a.length) return { messages: incoming, gap: false };
  // A nonvirtualized page may expose a subset of already captured messages.
  for (let start = 0; start + b.length <= a.length; start++) {
    if (b.every((k, i) => k === a[start + i])) return { messages: existing, gap: false };
  }
  for (let overlap = Math.min(a.length, b.length); overlap > 0; overlap--) {
    if (a.slice(-overlap).every((k, i) => k === b[i])) {
      return { messages: [...existing, ...incoming.slice(overlap)], gap: false };
    }
  }
  // Keep both windows and flag the unverified boundary instead of dropping messages.
  return { messages: [...existing, ...incoming], gap: true };
}

const delay = ms => new Promise(done => setTimeout(done, ms));
const interrupted = signal => { if (signal?.aborted) throw new Error('Остановлено сотрудником.'); };

export async function discoverChats(page, provider, { maxScrolls = 200, waitMs = 700, signal } = {}) {
  const links = new Map();
  let stable = 0;
  let previous = '';
  await page.evaluate(discoverPage, { provider, reset: true });
  await delay(waitMs);
  for (let i = 0; i < maxScrolls; i++) {
    interrupted(signal);
    const snapshot = await page.evaluate(discoverPage, { provider, scroll: true });
    for (const link of snapshot.links) {
      const canonical = chatUrl(link.url, provider);
      if (canonical) links.set(canonical.id, { ...canonical, title: link.title });
    }
    const signature = JSON.stringify([links.size, snapshot.positions]);
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 5) return { links: [...links.values()], reason: 'ui-idle', complete: false };
    await delay(waitMs);
  }
  return { links: [...links.values()], reason: 'scroll-limit', complete: false };
}

async function captureDomChat(page, provider, target, {
  maxScrolls = 200, waitMs = 700, signal, navigate = true,
} = {}) {
  interrupted(signal);
  if (navigate) {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const status = response?.status();
    if ([401, 403, 429, 498].includes(status)) {
      const error = new Error('HTTP ' + status + ': очередь остановлена; повторите позже через обычный вход.');
      error.stopQueue = true;
      throw error;
    }
    if (status >= 400) throw new Error('Страница вернула HTTP ' + status);
    await delay(waitMs);
  }
  const canonical = chatUrl(await page.url(), provider);
  if (!canonical || canonical.id !== target.id) {
    const error = new Error('Страница перенаправлена или доступ закончился. Откройте нужный аккаунт вручную.');
    error.stopQueue = true;
    throw error;
  }
  const warnings = [];
  let topStable = 0;
  let signature = '';
  let reachedTop = false;
  let state;
  // Chat sites often initially position the view at the bottom. Start at the top.
  const topBudget = Math.min(40, Math.floor(maxScrolls / 2));
  for (let i = 0; i < topBudget; i++) {
    interrupted(signal);
    await page.evaluate(readPage, { provider, action: 'top' });
    await delay(waitMs);
    state = await readBound(page, provider, target);
    const current = JSON.stringify([state.scroll.height, state.messages[0], state.loading]);
    topStable = current === signature && state.scroll.top <= 2 ? topStable + 1 : 0;
    signature = current;
    if (topStable >= 3 && !state.loading) { reachedTop = true; break; }
  }
  if (!reachedTop) warnings.push('Не подтверждено начало диалога или ответ продолжает генерироваться.');
  let messages = [];
  const snapshots = [];
  let snapshotHash = '';
  let bottomStable = 0;
  let reachedBottom = false;
  let hasGap = false;
  let previousBottom = '';
  for (let i = 0; i < maxScrolls - topBudget; i++) {
    interrupted(signal);
    state = await readBound(page, provider, target);
    const merged = mergeWindow(messages, state.messages);
    messages = merged.messages;
    hasGap ||= merged.gap;
    const currentHash = JSON.stringify(state.messages);
    if (snapshotHash !== currentHash) {
      snapshots.push({ scroll: state.scroll, messages: state.messages });
      snapshotHash = currentHash;
    }
    const atBottom = state.scroll.top + state.scroll.viewport >= state.scroll.height - 3;
    const bottom = JSON.stringify([state.scroll, currentHash]);
    bottomStable = atBottom && previousBottom === bottom ? bottomStable + 1 : 0;
    previousBottom = bottom;
    if (bottomStable >= 3 && !state.loading) { reachedBottom = true; break; }
    await page.evaluate(readPage, { provider, action: 'down' });
    await delay(waitMs);
  }
  if (!reachedBottom) warnings.push('Достигнут предел прокрутки или конец диалога не подтверждён.');
  if (hasGap) warnings.push('Между окнами сообщений нет надёжного перекрытия: возможны пропуски/повторы. Все снимки текста сохранены.');
  if (state.loading) warnings.push('При сохранении ответ ещё генерировался.');
  if (!messages.length) {
    if (!state.fallbackText?.trim()) throw new Error('Сообщения не найдены. Возможно, интерфейс изменился или диалог недоступен.');
    warnings.push('Роли сообщений не распознаны; сохранён только неразобранный текст страницы.');
  }
  const finalUrl = chatUrl(await page.url(), provider);
  if (finalUrl?.id !== target.id) throw navigationError('conversation_navigation_changed', 'Во время чтения открылась другая страница; результат не сохранён.', true);
  return {
    id: target.id, provider, url: target.url, title: target.title || state.title,
    capturedAt: new Date().toISOString(), method: 'rendered-ui-v1',
    diagnostics: { selector_version: state.selectorVersion, role_candidates: state.roleCandidateCount, message_count: messages.length, reached_top: reachedTop, reached_bottom: reachedBottom, has_gap: hasGap },
    messages, warnings, snapshots, fallbackText: state.fallbackText, mediaCount: state.mediaCount,
    limitations: [
      'Сохранена только отображённая ветка и раскрытый текст; полнота диалога независимо не проверена',
      'Файлы, изображения, свёрнутые рассуждения, Canvas/Artifacts и инструкции проектов отдельно не скачаны',
      'Полнота списка аккаунта и правильность выбранного workspace не подтверждены автоматически',
      'Markdown получен из интерфейса; JSON содержит прочитанный текст и окна сообщений, а не исходную серверную запись',
    ],
  };
}


function navigationError(code, message, retryable = false) {
  const error = new Error(message); error.code = code; error.retryable = retryable; error.stopQueue = !retryable; return error;
}
async function readBound(page, provider, target) {
  const state = await page.evaluate(readPage, { provider });
  if (state.authBarrier) throw navigationError('conversation_auth_required', 'Чтение прервано окном входа.');
  if (chatUrl(state.url, provider)?.id !== target.id) throw navigationError('conversation_navigation_changed', 'Рабочая вкладка ещё не на запрошенном диалоге или сменила его.', true);
  return state;
}

export async function captureChat(page, provider, target, options = {}) {
  const { waitMs = 700, signal, navigate = true, readinessMs = 30000, onDiagnostic = () => {} } = options;
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = observeConversation(page, provider, target.id);
    let probeStarted = false, lastState, backendMethod = null, probeConsumed = false, sourcePending = false;
    const rejectedRecords = new WeakSet();
    try {
      interrupted(signal);
      if (!page.on) { await page.evaluate(sourceProbe, { action: 'arm', provider, id: target.id }).catch(() => {}); probeStarted = true; }
      if (navigate || attempt) {
        const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const status = response?.status();
        if ([401, 403, 429, 498].includes(status)) throw navigationError('conversation_access_denied', 'HTTP ' + status + ': очередь остановлена без повтора.');
        if (status >= 400) { const error = new Error('Страница вернула HTTP ' + status); error.code = 'conversation_http_error'; throw error; }
      }
      const start = Date.now(); let stable = 0, previous = '';
      while (Date.now() - start < readinessMs) {
        interrupted(signal);
        if (observed.state.error) throw observed.state.error;
        lastState = await readBound(page, provider, target);
        sourcePending = !!(observed.state.pending.size || observed.state.inFlight.size);
        let record = observed.state.record;
        if (record) backendMethod = 'observed-response';
        if (!record && !page.on) {
          if ((await page.evaluate(sourceProbe, { action: 'result', provider, id: target.id })).phase === 'unavailable') await page.evaluate(sourceProbe, { action: 'arm', provider, id: target.id });
          if (probeStarted) {
            const probe = await page.evaluate(sourceProbe, { action: 'result', provider, id: target.id });
            sourcePending ||= ['requested', 'reading'].includes(probe.phase);
            if (probe.status >= 400 && ![401, 403, 429, 498].includes(probe.status)) { const error = new Error('HTTP ' + probe.status + ' в ответе интерфейса.'); error.code = 'conversation_source_http_error'; error.retryable = probe.status >= 500; throw error; }
            if ([401, 403, 429, 498].includes(probe.status)) throw navigationError('conversation_access_denied', 'HTTP ' + probe.status + ' при чтении наблюдённого JSON.');
            if (probe.phase === 'ready' && !probeConsumed) { probeConsumed = true; record = conversationRecord(probe.payload, provider, target.id); backendMethod = 'passive-browser-fetch'; }
          }
        }
        if (record && rejectedRecords.has(record)) record = null;
        if (record) {
          const { normalizeOfficial } = await import('./archive.mjs');
          let chat;
          try { chat = normalizeOfficial(record, provider); }
          catch { rejectedRecords.add(record); onDiagnostic({ attempt, outcome: 'source_schema_rejected' }); }
          if (!chat) { await delay(Math.max(10, Math.min(waitMs, 300))); continue; }
          if (chat.id !== target.id) throw navigationError('conversation_identity_mismatch', 'JSON принадлежит другому диалогу.');
          await readBound(page, provider, target);
          if (chat.messages.some(message => !['user', 'assistant', 'system', 'developer', 'tool'].includes(message.role))) chat.warnings.push('В исходном JSON есть неизвестная роль сообщения; требуется проверка.');
          chat.method = 'observed-ui-json-v1'; chat.url = target.url; chat.source_transport = backendMethod;
          if (lastState.loading || provider === 'chatgpt' && Object.values(record.mapping).some(node => node.message?.status === 'in_progress')) chat.warnings.push('Ответ ещё генерируется: сохранён доступный снимок JSON.');
          chat.limitations = ['Сохранён JSON диалога, полученный авторизованным интерфейсом; бинарные вложения отдельно не скачаны', 'Полнота аккаунта и выбранное рабочее пространство независимо не подтверждены'];
          onDiagnostic({ attempt, outcome: 'saved_json', source: backendMethod, message_count: chat.messages.length });
          return chat;
        }
        const signature = JSON.stringify(lastState.messages);
        stable = signature === previous && lastState.messages.length && !lastState.loading ? stable + 1 : 0; previous = signature;
        if (stable >= 2 && !sourcePending && Date.now() - start >= Math.min(2000, waitMs * 3)) break;
        await delay(Math.max(10, Math.min(waitMs, 300)));
      }
      if (observed.state.error) throw observed.state.error;
      if (sourcePending) throw navigationError('conversation_load_timeout', 'Интерфейс ещё загружает выбранный диалог; старый текст не сохранён.', true);
      const chat = await captureDomChat(page, provider, target, { ...options, navigate: false });
      onDiagnostic({ attempt, outcome: chat.warnings.length ? 'partial_dom' : 'saved_dom', source: 'rendered-ui-v1', ...chat.diagnostics });
      return chat;
    } catch (error) {
      onDiagnostic({ attempt, outcome: 'error', code: error.code || error.name, role_candidates: lastState?.roleCandidateCount || 0, backend_observed: observed.state.observed });
      let onProvider = false;
      try { onProvider = new URL(await page.url()).origin === PROVIDERS[provider].origin; } catch { /* Closed browser. */ }
      if (!error.stopQueue && !page.isClosed() && (error.name === 'TimeoutError' || /execution context was destroyed|ERR_CONNECTION_RESET/i.test(error.message))) error.retryable = true;
      if (!onProvider || page.isClosed()) { error.stopQueue = true; error.retryable = false; }
      if (!attempt && error.retryable && onProvider && !signal?.aborted) continue;
      throw error;
    } finally {
      observed.close();
      if (probeStarted && !page.isClosed()) await page.evaluate(sourceProbe, { action: 'clear', provider, id: target.id }).catch(() => {});
    }
  }
}
