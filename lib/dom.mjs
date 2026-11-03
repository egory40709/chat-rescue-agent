// These functions run in the page. Keep them self-contained: no imports or secrets.
export function readPage({ provider, action = 'read', metadataOnly = false }) {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const selector = provider === 'chatgpt'
    ? '[data-message-author-role], article[data-testid^="conversation-turn-"], article[data-turn="user"], article[data-turn="assistant"], [data-role="user"], [data-role="assistant"], [data-author="user"], [data-author="assistant"]'
    : '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
  const roleOf = el => {
    if (provider !== 'chatgpt') return el.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
    const explicit = el.getAttribute('data-message-author-role') || el.getAttribute('data-turn') || el.getAttribute('data-role') || el.getAttribute('data-author');
    if (['user', 'assistant', 'system', 'developer', 'tool'].includes(explicit)) return explicit;
    const label = (el.getAttribute('aria-label') || el.querySelector('h5.sr-only,h6.sr-only,[data-testid="author-label"]')?.textContent || '').trim();
    if (/^(?:you said|вы сказали|user)[:：]?$/i.test(label)) return 'user';
    if (/^(?:chatgpt said|chatgpt сказал|chatgpt|assistant)[:：]?$/i.test(label)) return 'assistant';
    return null;
  };
  const candidates = [...document.querySelectorAll(selector)].filter(el => visible(el) && roleOf(el));
  const roots = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
  const main = document.querySelector('main, [role="main"]');
  const authBarrier = /\/(?:auth|login|signin)(?:\/|$)/i.test(location.pathname) || [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].filter(visible).some(el => /войти|log in|sign in|continue with google|продолжить с помощью google/i.test(el.innerText));
  // Match the provider's top-level error shell, never a phrase quoted in a chat.
  // Do not return its explanation: it can contain the visitor's IP and Ray ID.
  const errorShell = document.querySelector('body > .container');
  const errorHeading = errorShell?.querySelector(':scope > .message p');
  const siteBarrier = provider === 'chatgpt' && !roots.length && errorHeading && visible(errorHeading)
    && errorHeading.textContent.trim() === 'Unable to load site'
    && errorShell.querySelector(':scope > .message .blocked-icon')
    && [...errorShell.querySelectorAll(':scope > .explanation a[href]')].some(link => {
      try { return new URL(link.href).origin === 'https://status.openai.com'; } catch { return false; }
    }) ? { code: 'provider_site_unavailable', reason: 'unable_to_load_site' } : null;
  if (metadataOnly) {
    const links = [...document.querySelectorAll('aside a[href], nav a[href], [role="navigation"] a[href], main a[href]')].filter(node => {
      if (!visible(node)) return false;
      try { const url = new URL(node.href); return url.origin === location.origin && /\/(?:c|chat)\/[\w-]+\/?$/.test(url.pathname); } catch { return false; }
    }).length;
    const onChat = /\/(?:c|chat)\/[\w-]+\/?$/.test(location.pathname);
    const loginButton = !roots.length && !links && [...document.querySelectorAll('a[href*="/auth/login"],button[data-testid="login-button"]')].some(visible);
    return { observable: !siteBarrier && (roots.length > 0 || links > 0 || onChat && !!main && !loginButton),
      messages: roots.length, links, auth_barrier: authBarrier || loginButton, site_barrier: siteBarrier };
  }
  if (siteBarrier) return { messages: [], loading: false, authBarrier: false, siteBarrier, selectorVersion: 2,
    roleCandidateCount: 0, fallbackText: '', mediaCount: 0, url: location.href, scroll: { top: 0, height: 0, viewport: 0 } };
  const scrolling = () => {
    let el = roots[0]?.parentElement;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  };
  const scroll = scrolling();
  const dimensions = () => ({ top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight });
  if (action === 'top') {
    scroll.scrollTop = 0;
    return dimensions();
  }
  if (action === 'down') {
    scroll.scrollTop += Math.max(200, scroll.clientHeight * 0.7);
    return dimensions();
  }
  function markdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'button', 'svg', 'textarea', 'input', 'noscript'].includes(tag)
      || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden') || getComputedStyle(node).display === 'none') return '';
    if (tag === 'pre') {
      const code = node.querySelector('code') || node;
      const text = code.textContent;
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
      const fence = '`'.repeat(longest + 1);
      return '\n\n' + fence + '\n' + text + '\n' + fence + '\n\n';
    }
    if (tag === 'img') return '\n[Изображение: ' + (node.getAttribute('alt') || 'без подписи') + '; файл не скачан]\n';
    const body = [...node.childNodes].map(markdown).join('');
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + body + '\n\n';
    if (tag === 'br') return '\n';
    if (tag === 'li') return '\n- ' + body.trim() + '\n';
    if (tag === 'tr') return '\n' + body + '\n';
    if (tag === 'td' || tag === 'th') return body + ' | ';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      // Keep link targets as inert text; offline archives never fetch them.
      return /^https?:|^\//.test(href) ? body + ' (' + href + ')' : body;
    }
    if (tag === 'strong' || tag === 'b') return '**' + body + '**';
    if (tag === 'em' || tag === 'i') return '*' + body + '*';
    if (tag === 'code') return '`' + body + '`';
    if (['p', 'div', 'section', 'article', 'blockquote', 'ul', 'ol', 'table'].includes(tag)) return '\n\n' + body + '\n\n';
    return body;
  }
  const messages = roots.map(el => {
    const role = roleOf(el);
    const blocks = [...el.querySelectorAll('[data-message-content], .markdown, .prose')];
    const content = blocks.length === 1 ? blocks[0] : el;
    return {
      role,
      markdown: markdown(content).trim(),
      text: content.innerText,
      domId: el.getAttribute('data-message-id') || el.closest('[data-message-id]')?.getAttribute('data-message-id') || null,
    };
  }).filter(m => m.markdown || m.text);
  const loading = !!main?.querySelector('[aria-busy="true"]') || !!document.querySelector('[data-is-streaming="true"], [data-testid="stop-button"], button[aria-label="Stop streaming"]');
  return {
    title: document.title,
    url: location.href,
    messages,
    loading, authBarrier, siteBarrier, selectorVersion: 2, roleCandidateCount: candidates.length,
    // Retain a readable fallback, but never report it as an extracted transcript.
    fallbackText: messages.length ? null : main?.innerText || '',
    scroll: dimensions(),
    mediaCount: roots.reduce((n, el) => n + el.querySelectorAll('img, video, audio, a[download]').length, 0),
  };
}

export function discoverPage({ provider, scroll = false, reset = false }) {
  const isChat = /\/(?:c|chat)\/[\w-]+/.test(location.pathname);
  const selector = 'aside, nav, [role="navigation"], [data-testid="sidebar"]';
  const scopes = [...document.querySelectorAll(selector)];
  if (!isChat) scopes.push(document.querySelector('main, [role="main"]'));
  const visible = el => el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const links = [];
  const containers = new Set();
  const expectedHost = provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
  for (const scope of scopes.filter(visible)) {
    for (const a of scope.querySelectorAll('a[href]')) {
      const url = new URL(a.getAttribute('href'), location.href);
      const match = provider === 'chatgpt' ? url.pathname.match(/\/(?:c)\/([\w-]+)\/?$/)
        : url.pathname.match(/^\/chat\/([\w-]+)\/?$/);
      if (url.hostname !== expectedHost || !match || !visible(a)) continue;
      links.push({ url: url.origin + url.pathname, title: a.innerText.trim() });
      let el = a.parentElement;
      while (el) {
        if (el.scrollHeight > el.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(el).overflowY)) containers.add(el);
        el = el.parentElement;
      }
    }
  }
  if (!isChat && document.scrollingElement) containers.add(document.scrollingElement);
  for (const el of containers) {
    if (reset) el.scrollTop = 0;
    else if (scroll) el.scrollTop += Math.max(200, el.clientHeight * 0.7);
  }
  return {
    links,
    // Idle only means no new UI links. It never establishes a full account inventory.
    positions: [...containers].map(el => [el.scrollTop, el.scrollHeight, el.clientHeight]),
  };
}
