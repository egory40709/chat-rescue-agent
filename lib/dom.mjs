// These functions run in the page. Keep them self-contained: no imports or secrets.
export function readPage({ provider, action = 'read', metadataOnly = false }) {
  const visible = el => getComputedStyle(el).visibility !== 'hidden'
    && (!!el.getClientRects().length || getComputedStyle(el).display === 'contents' && [...el.children].some(visible));
  const selector = provider === 'chatgpt'
    ? '[data-message-author-role], article[data-testid^="conversation-turn-"], article[data-turn="user"], article[data-turn="assistant"], [data-role="user"], [data-role="assistant"], [data-author="user"], [data-author="assistant"]'
    : '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
  const headingRoles = new Map();
  if (provider === 'chatgpt') for (const heading of document.querySelectorAll('main [data-conversation-role], [role="main"] [data-conversation-role]')) {
    const role = heading.getAttribute('data-conversation-role');
    if (!['user', 'assistant', 'system', 'developer', 'tool'].includes(role) || !heading.parentElement) continue;
    const roles = headingRoles.get(heading.parentElement) || new Set(); roles.add(role); headingRoles.set(heading.parentElement, roles);
  }
  const roleOf = el => {
    if (provider !== 'chatgpt') return el.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
    const explicit = el.getAttribute('data-message-author-role') || el.getAttribute('data-turn') || el.getAttribute('data-role') || el.getAttribute('data-author');
    if (['user', 'assistant', 'system', 'developer', 'tool'].includes(explicit)) return explicit;
    const heading = headingRoles.get(el);
    if (heading?.size === 1) return [...heading][0];
    const label = (el.getAttribute('aria-label') || el.querySelector('h5.sr-only,h6.sr-only,[data-testid="author-label"]')?.textContent || '').trim();
    if (/^(?:you said|вы сказали|user)[:：]?$/i.test(label)) return 'user';
    if (/^(?:chatgpt said|chatgpt сказал|chatgpt|assistant)[:：]?$/i.test(label)) return 'assistant';
    return null;
  };
  // Both layouts may coexist; hidden legacy nodes must not suppress headings.
  const candidates = [...new Set([...document.querySelectorAll(selector), ...headingRoles.keys()])].filter(el => visible(el) && roleOf(el))
    .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
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
  if (siteBarrier) return { messages: [], loading: false, authBarrier: false, siteBarrier, selectorVersion: 3,
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
  const controls = 'script, style, button, svg, textarea, input, noscript, [aria-hidden="true"], [hidden], [data-conversation-role], [role="button"], [role="toolbar"]';
  const skip = node => node.matches(controls) || getComputedStyle(node).display === 'none'
    || getComputedStyle(node).visibility === 'hidden';
  function plainText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || skip(node)) return '';
    const tag = node.tagName.toLowerCase(), body = [...node.childNodes].map(plainText).join('');
    if (tag === 'br') return '\n';
    if (tag === 'td' || tag === 'th') return body + '\t';
    return /^(?:p|div|section|article|blockquote|ul|ol|li|table|tr|pre|h[1-6])$/.test(tag) ? '\n\n' + body + '\n\n' : body;
  }
  function markdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (skip(node)) return '';
    if (tag === 'pre' || node.hasAttribute('data-code-block') || node.hasAttribute('data-code-block-source')) {
      const code = node.hasAttribute('data-code-block-source') ? node : node.querySelector('[data-code-block-source], code');
      const text = code ? code.textContent : plainText(node).trim();
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
    const content = headingRoles.has(el) || blocks.length !== 1 ? el : blocks[0];
    const ids = new Set(); let ambiguousId = false;
    const legacyId = el.getAttribute('data-message-id') || el.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (legacyId) ids.add(legacyId);
    for (const node of [el, ...el.querySelectorAll('[data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]')]) {
      const selected = node.getAttribute('data-chatgpt-selection-message-id'); if (selected) ids.add(selected);
      const search = node.getAttribute('data-chatgpt-search-message-ids');
      if (search) {
        try {
          const values = JSON.parse(search);
          if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0]) ambiguousId = true;
          else ids.add(values[0]);
        } catch { ambiguousId = true; }
      }
    }
    return {
      role,
      markdown: markdown(content).trim(),
      text: plainText(content).trim(),
      domId: !ambiguousId && ids.size === 1 ? [...ids][0] : null,
      media: [...el.querySelectorAll('img, video, audio, a[download]')].filter(node => visible(node) && !node.closest('[data-conversation-role],button,[role="toolbar"]')).map(node => ({
        kind: node.tagName.toLowerCase(), url: node.currentSrc || node.src || node.href || '', alt: node.getAttribute('alt') || '',
      })).filter(item => item.url),
    };
  }).filter(m => m.markdown || m.text);
  const loading = !!main?.querySelector('[aria-busy="true"]') || !!document.querySelector('[data-is-streaming="true"], [data-testid="stop-button"], button[aria-label="Stop streaming"]');
  return {
    title: document.title,
    url: location.href,
    messages,
    loading, authBarrier, siteBarrier, selectorVersion: 3, roleCandidateCount: candidates.length,
    // Retain a readable fallback, but never report it as an extracted transcript.
    fallbackText: messages.length ? null : main?.innerText || '',
    scroll: dimensions(),
    mediaCount: messages.reduce((n, message) => n + message.media.length, 0),
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
