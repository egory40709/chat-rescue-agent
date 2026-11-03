import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';
import { attachExistingBrowser, providerUrl } from './existing-browser.mjs';

const MAX_PACKAGE = 16 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = signal => { if (signal?.aborted) throw new Error('Остановлено пользователем.'); };
export function validateSkillZip(bytes) {
  if (bytes.length > MAX_PACKAGE || bytes.length < 22) throw new Error('Некорректный размер ZIP Skill.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Ответ не является поддерживаемым ZIP.');
  const count = bytes.readUInt16LE(end + 10), directory = bytes.readUInt32LE(end + 16);
  if (!count || count > 10000 || directory >= end) throw new Error('ZIP Skill пуст или превышает допустимые пределы.');
  const files = [], names = new Set(); let at = directory, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Повреждён каталог ZIP Skill.');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const nameSize = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42), mode = bytes.readUInt32LE(at + 38) >>> 16;
    const name = bytes.subarray(at + 46, at + 46 + nameSize).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.') || name.includes('\0') || names.has(name)) throw new Error('Недопустимое имя файла в ZIP Skill.');
    names.add(name);
    if ((flags & 1) || ![0, 8].includes(method) || (mode & 0o170000) === 0o120000) throw new Error('ZIP Skill содержит неподдерживаемый файл.');
    expanded += size;
    if (expanded > 128 * 1024 * 1024 || size > 32 * 1024 * 1024 || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP Skill превышает пределы или повреждён.');
    const localNameSize = bytes.readUInt16LE(local + 26);
    if (bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) & 1) throw new Error('Расходятся локальная запись и каталог ZIP.');
    const start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
    if (start + packed > directory) throw new Error('Повреждены данные ZIP Skill.');
    const compressed = bytes.subarray(start, start + packed);
    const content = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }) : compressed;
    if (content.length !== size || crc32(content) !== crc) throw new Error('Не совпадает контрольная сумма ZIP Skill.');
    if (!name.endsWith('/')) files.push({ path: name, bytes: size });
    at += 46 + nameSize + extra + comment;
  }
  if (at !== end || !files.some(file => /(^|\/)skill\.md$/i.test(file.path))) throw new Error('В ZIP отсутствует SKILL.md или повреждён каталог.');
  return files;
}

// Runs only in the exporter's own Claude tab. Never evaluates downloaded skill code.
export function skillWebAction({ action, target, maxBytes = 16777216, allowMenu = true }) {
  const visible = el => el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const label = el => (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ');
  const safe = el => !el.closest('pre,code,textarea,[contenteditable="true"],[data-message-author-role],.markdown,.prose');
  const controls = () => [...document.querySelectorAll('main a[href],main button,main [role="button"],[role="main"] a[href],[role="main"] button,[role="main"] [role="button"],[role="dialog"] a[href],[role="dialog"] button,[role="menuitem"]')].filter(el => visible(el) && safe(el));
  const auth = () => /\/(login|auth|signin)(\/|$)/i.test(location.pathname) || [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')].filter(visible).some(el => /log in|sign in|войти/i.test(el.innerText));
  if (auth()) return { error: 'source_auth_required' };
  if (action === 'list') {
    const items = [];
    for (const el of controls()) {
      const text = label(el), href = el.getAttribute('href');
      let url;
      if (href) { try { const candidate = new URL(href, location.href); if (candidate.origin === location.origin && /^\/customize\/skills\/[^/]+\/?$/.test(candidate.pathname)) url = candidate.href; } catch { /* Not a skill link. */ } }
      const card = el.matches('[data-testid*="skill-card"],[data-skill-id]') || !!el.querySelector('h2,h3,h4');
      if (!url && !card) continue;
      if (!text || /^(add|create|upload|browse|добавить|создать|загрузить)\b/i.test(text)) continue;
      items.push({ name: text.slice(0, 240), ...(url ? { url } : { label: text }) });
    }
    const scrollers = [...document.querySelectorAll('main,main *,[role="main"] *')].filter(el => visible(el) && el.scrollHeight > el.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    if (document.scrollingElement) scrollers.push(document.scrollingElement);
    for (const el of scrollers) el.scrollTop += Math.max(200, el.clientHeight * 0.7);
    return { items, positions: scrollers.map(el => [el.scrollTop, el.scrollHeight]), empty: /no skills|you haven.t added|нет навыков|нет скиллов/i.test(document.querySelector('main')?.innerText || '') };
  }
  if (action === 'open') {
    const matches = controls().filter(el => label(el) === target.label);
    if (matches.length !== 1) return { error: 'skill_card_changed' };
    matches[0].click(); return { opened: true };
  }
  if (action === 'download') {
    const choices = controls().filter(el => /^(download(?: skill| zip|\.zip)?|скачать(?: навык| скилл| zip)?)$/i.test(label(el)) || el.tagName === 'A' && el.hasAttribute('download'));
    if (choices.length === 1) { choices[0].click(); return { clicked: true }; }
    if (choices.length > 1) return { error: 'ambiguous_skill_download' };
    const menus = controls().filter(el => /^(?:\.\.\.|…|more(?: options| actions)?|options|menu|ещ[её]|опции|действия)$/i.test(label(el)));
    if (allowMenu && menus.length === 1) { menus[0].click(); return { menu_opened: true }; }
    return { error: 'skill_download_unavailable' };
  }
  if (action === 'arm') {
    const originalCreate = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
    const state = { phase: 'waiting', blobs: new Map() };
    const store = blob => {
      if (state.phase !== 'waiting') return;
      state.phase = 'reading';
      if (blob.size > maxBytes) { state.phase = 'failed'; state.error = 'skill_download_size_limit'; return; }
      const reader = new FileReader();
      reader.onerror = () => { state.phase = 'failed'; state.error = 'skill_download_read_failed'; };
      reader.onload = () => { state.base64 = String(reader.result).split(',')[1]; state.phase = 'ready'; };
      reader.readAsDataURL(blob);
    };
    const fetchFile = url => {
      if (state.phase !== 'waiting') return;
      let parsed;
      try { parsed = new URL(url, location.href); } catch { state.phase = 'failed'; state.error = 'invalid_download_url'; return; }
      if (!(parsed.origin === location.origin && ['https:', 'blob:'].includes(parsed.protocol)) || parsed.username || parsed.password) {
        state.phase = 'failed'; state.error = 'cross_origin_skill_download'; return;
      }
      state.phase = 'fetching';
      fetch(parsed.href, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000) }).then(async response => {
        if (!response.ok) { state.phase = 'failed'; state.error = 'skill_download_http_' + response.status; return; }
        const limit = Number(response.headers.get('content-length'));
        if (limit > maxBytes) throw new Error('size');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('size'); } chunks.push(part.value); }
        state.phase = 'waiting'; store(new Blob(chunks));
      }).catch(() => { state.phase = 'failed'; state.error = 'skill_download_failed'; });
    };
    URL.createObjectURL = function(blob) { const url = originalCreate.call(URL, blob); state.blobs.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() {
      if (this.hasAttribute('download') || this.href.startsWith('blob:')) {
        const blob = state.blobs.get(this.href);
        if (blob) store(blob); else fetchFile(this.href);
        return;
      }
      return originalClick.call(this);
    };
    state.restore = () => { URL.createObjectURL = originalCreate; HTMLAnchorElement.prototype.click = originalClick; };
    window.__chatRescueSkillDownload = state;
    return { armed: true };
  }
  if (action === 'result') {
    const state = window.__chatRescueSkillDownload;
    return state ? { phase: state.phase, ...(state.error ? { error: state.error } : {}), ...(state.phase === 'ready' ? { base64: state.base64 } : {}) } : { error: 'download_capture_lost' };
  }
  if (action === 'restore') {
    window.__chatRescueSkillDownload?.restore(); delete window.__chatRescueSkillDownload; return { restored: true };
  }
  return { error: 'unknown_skill_action' };
}

export async function collectWebSkills(archive, { cdp_endpoint, source_tab, browser = 'chrome', signal, attach = attachExistingBrowser,
  wait_ms = 400, max_scrolls = 100, download_timeout = 20000, onProgress = () => {} } = {}) {
  let context;
  try {
    check(signal);
    context = await attach({ provider: 'claude', browser, cdpEndpoint: cdp_endpoint, sourceTab: source_tab });
    const page = context.pages()[0];
    const goto = async url => {
      check(signal);
      if (!providerUrl(url, 'claude')) throw new Error('Ссылка Skill ведёт за пределы Claude.');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if ([401, 403, 429, 498].includes(response?.status())) { const error = new Error('HTTP ' + response.status() + ' при чтении Skills.'); error.stopQueue = true; throw error; }
      await delay(wait_ms);
    };
    const invoke = async args => {
      check(signal); if (!providerUrl(await page.url(), 'claude')) throw new Error('Сессия Claude требует входа.');
      return page.evaluate(skillWebAction, args);
    };
    const index = 'https://claude.ai/customize/skills';
    await goto(index);
    const targets = new Map(); let stable = 0, last = ''; const discoveryStarted = Date.now();
    for (let i = 0; i < max_scrolls; i++) {
      const observed = await invoke({ action: 'list' });
      if (observed.error) throw new Error(observed.error);
      for (const item of observed.items) targets.set(item.url || item.label, item);
      const current = JSON.stringify([targets.size, observed.positions]);
      stable = current === last ? stable + 1 : 0; last = current;
      if (stable >= 8 && (targets.size || observed.empty || Date.now() - discoveryStarted >= 15000)) break;
      await delay(wait_ms);
    }
    if (!targets.size) { archive.manifest.issues.push({ source: 'claude-web', reason: 'web_skill_list_unavailable_or_empty' }); return; }
    for (const target of targets.values()) {
      check(signal); onProgress({ phase: 'exporting_web_skills', current: target.name, discovered: targets.size });
      try {
        if (target.url) await goto(target.url);
        else { await goto(index); const opened = await invoke({ action: 'open', target }); if (opened.error) throw new Error(opened.error); await delay(wait_ms); }
        await invoke({ action: 'arm', maxBytes: MAX_PACKAGE });
        let clicked, menuOpened = false; const controlsStarted = Date.now();
        do {
          clicked = await invoke({ action: 'download', allowMenu: !menuOpened });
          menuOpened ||= !!clicked.menu_opened;
          if (clicked.error && clicked.error !== 'skill_download_unavailable') throw new Error(clicked.error);
          if (clicked.clicked) break;
          await delay(wait_ms);
        } while (Date.now() - controlsStarted < Math.min(download_timeout, 15000));
        if (!clicked.clicked) throw new Error(clicked.error || 'skill_download_unavailable');
        let result, start = Date.now();
        do {
          await delay(Math.min(wait_ms, 200)); result = await invoke({ action: 'result' });
          if (result.error) throw new Error(result.error);
        } while (result.phase !== 'ready' && Date.now() - start < download_timeout);
        if (result.phase !== 'ready') throw new Error('skill_download_timeout');
        const content = Buffer.from(result.base64, 'base64');
        const files = validateSkillZip(content);
        await archive.add({ name: target.name, source: 'claude-web', origin: target.url || 'claude-skill:' + target.label, content, files });
      } catch (error) {
        archive.manifest.skills.push({ name: target.name, source: 'claude-web', status: 'failed', error: error.message });
        if (error.stopQueue || /skill_download_http_(401|403|429|498)/.test(error.message)) throw error;
      } finally { await page.evaluate(skillWebAction, { action: 'restore' }).catch(() => {}); }
    }
  } catch (error) { archive.manifest.issues.push({ source: 'claude-web', reason: error.code || error.message }); }
  finally { await context?.close().catch(() => {}); }
}
