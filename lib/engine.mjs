import { readPage, discoverPage } from './dom.mjs';

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

export async function captureChat(page, provider, target, {
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
  const selector = provider === 'chatgpt' ? '[data-message-author-role]'
    : '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
  try { await page.locator(selector).first().waitFor({ state: 'attached', timeout: 15000 }); }
  catch { /* Read a clearly marked fallback, or fail below. */ }
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
    state = await page.evaluate(readPage, { provider });
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
    state = await page.evaluate(readPage, { provider });
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
  if (finalUrl?.id !== target.id) throw new Error('Во время чтения открылась другая страница; результат не сохранён.');
  return {
    id: target.id, provider, url: target.url, title: target.title || state.title,
    capturedAt: new Date().toISOString(), method: 'rendered-ui-v1',
    messages, warnings, snapshots, fallbackText: state.fallbackText, mediaCount: state.mediaCount,
    limitations: [
      'Сохранена только отображённая ветка и раскрытый текст; полнота диалога независимо не проверена',
      'Файлы, изображения, свёрнутые рассуждения, Canvas/Artifacts и инструкции проектов отдельно не скачаны',
      'Полнота списка аккаунта и правильность выбранного workspace не подтверждены автоматически',
      'Markdown получен из интерфейса; JSON содержит прочитанный текст и окна сообщений, а не исходную серверную запись',
    ],
  };
}
