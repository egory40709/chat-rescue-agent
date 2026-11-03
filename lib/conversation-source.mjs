// Read only data the authorised UI itself requested; never invent backend endpoints.
const ORIGINS = { chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai' };
export function conversationRecord(payload, provider, id) {
  const seen = new Set(); let budget = 2000;
  const find = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 6 || --budget < 0) return null;
    seen.add(value);
    const actual = String(value.conversation_id || value.conversation_uuid || value.uuid || value.id || '');
    const shape = provider === 'chatgpt' ? value.mapping && value.current_node : Array.isArray(value.chat_messages);
    if (actual === id && shape) return value;
    for (const [key, child] of Object.entries(value)) {
      if (['mapping', 'chat_messages', 'messages', 'content'].includes(key)) continue;
      if (child && typeof child === 'object') { const record = find(child, depth + 1); if (record) return record; }
    }
    return null;
  };
  return find(payload);
}
export function isConversationRequest(value, provider, id) {
  try {
    const url = new URL(value);
    return url.origin === ORIGINS[provider] && !url.username && !url.password
      && url.pathname.split('/').some(part => decodeURIComponent(part) === id)
      && /conversation|messages|chats?/i.test(url.pathname) && !/^\/(c|chat)\//.test(url.pathname);
  } catch { return false; }
}
export function observeConversation(page, provider, id) {
  const state = { record: null, error: null, observed: 0, method: 'observed-response', pending: new Set(), inFlight: new Set() };
  const requestListener = request => { if (request.method() === 'GET' && isConversationRequest(request.url(), provider, id)) state.inFlight.add(request); };
  const failedListener = request => state.inFlight.delete(request);
  const listener = response => {
    if (!isConversationRequest(response.url(), provider, id) || response.request().method() !== 'GET') return;
    state.inFlight.delete(response.request()); state.observed++;
    const status = response.status();
    if ([401, 403, 429, 498].includes(status)) {
      const error = new Error('HTTP ' + status + ' при чтении данных диалога.'); error.code = 'conversation_access_denied'; error.stopQueue = true; state.error = error; return;
    }
    if (status >= 400) { const error = new Error('HTTP ' + status + ' в ответе данных диалога.'); error.code = 'conversation_source_http_error'; error.retryable = status >= 500; state.error = error; return; }
    if (status !== 200 || !/json/i.test(response.headers()['content-type'] || '') || Number(response.headers()['content-length']) > 8 * 1024 * 1024) return;
    const task = response.text().then(text => {
      if (text.length <= 8 * 1024 * 1024) state.record ||= conversationRecord(JSON.parse(text), provider, id);
    }).catch(() => {}).finally(() => state.pending.delete(task));
    state.pending.add(task);
  };
  page.on?.('request', requestListener); page.on?.('requestfailed', failedListener); page.on?.('response', listener);
  return { state, close: () => { page.off?.('request', requestListener); page.off?.('requestfailed', failedListener); page.off?.('response', listener); } };
}

// In the native macOS working tab, observe the UI's own fetch response. Preserve
// its original promise/headers; never read, copy or reconstruct session credentials.
export function sourceProbe({ action, id, provider }) {
  const origin = provider === 'chatgpt' ? 'https://chatgpt.com' : 'https://claude.ai';
  if (location.origin !== origin) return { phase: 'failed', code: 'source_changed' };
  if (action === 'arm') {
    if (window.__chatRescueSource?.id === id) return { phase: window.__chatRescueSource.phase };
    window.__chatRescueSource?.restore?.();
    const original = window.fetch;
    const state = { id, phase: 'waiting' };
    const wrapped = function(...args) {
      const result = original.apply(this, args);
      let url, method;
      try {
        url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url, location.href);
        method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
      } catch { return result; }
      let matches = false;
      try { matches = method === 'GET' && url.origin === origin && /conversation|messages|chats?/i.test(url.pathname)
        && url.pathname.split('/').some(part => decodeURIComponent(part) === id) && !/^\/(c|chat)\//.test(url.pathname); } catch { return result; }
      if (matches) state.phase = 'requested';
      if (matches) result.then(async response => {
        state.status = response.status;
        if ([401, 403, 429, 498].includes(response.status)) { state.phase = 'failed'; state.code = 'ui_json_access_denied'; return; }
        if (!response.ok) { state.phase = 'failed'; state.code = 'ui_json_http_' + response.status; return; }
        if (!/json/i.test(response.headers.get('content-type') || '')) { state.phase = 'unavailable'; return; }
        state.phase = 'reading';
        const reader = response.clone().body.getReader(), chunks = []; let size = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('size_limit'); }
          chunks.push(part.value);
        }
        state.payload = JSON.parse(await new Blob(chunks).text()); state.phase = 'ready';
      }).catch(() => { if (state.phase !== 'ready') { state.phase = 'failed'; state.code = 'ui_json_unavailable'; } });
      return result;
    };
    window.fetch = wrapped;
    state.restore = () => { if (window.fetch === wrapped) window.fetch = original; };
    window.__chatRescueSource = state;
    return { phase: 'waiting' };
  }
  if (action === 'result') {
    const state = window.__chatRescueSource;
    return state?.id === id ? { phase: state.phase, status: state.status, code: state.code, ...(state.phase === 'ready' ? { payload: state.payload } : {}) } : { phase: 'unavailable' };
  }
  if (action === 'clear') { window.__chatRescueSource?.restore?.(); delete window.__chatRescueSource; return { cleared: true }; }
  return { phase: 'unavailable' };
}
