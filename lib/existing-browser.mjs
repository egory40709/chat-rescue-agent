import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { PROVIDERS } from './engine.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const APPS = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', chromium: 'Chromium' };
export class BrowserConnectionError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export function providerUrl(url, provider) {
  try { return new URL(url).origin === PROVIDERS[provider]?.origin; } catch { return false; }
}
export function chooseSource(candidates, sourceTab) {
  if (sourceTab !== undefined) {
    const selected = candidates.find(tab => String(tab.id) === String(sourceTab));
    if (!selected) throw new BrowserConnectionError('source_tab_not_found', 'Выбранная вкладка не найдена среди вкладок нужного сервиса.');
    return selected;
  }
  const focused = candidates.filter(tab => tab.focused);
  if (focused.length === 1) return focused[0];
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new BrowserConnectionError('no_source_tab', 'Откройте нужный аккаунт ChatGPT/Claude в обычном браузере. Новое окно входа не создавалось.');
  throw new BrowserConnectionError('source_tab_required', 'Найдено несколько вкладок. Сделайте нужную активной или передайте source_tab.', {
    candidates: candidates.map(tab => ({ id: tab.id, url: new URL(tab.url).origin + new URL(tab.url).pathname })),
  });
}
export function localCdpEndpoint(value, websocket = false) {
  let url;
  try { url = new URL(value); } catch { throw new BrowserConnectionError('invalid_cdp_endpoint', 'Нужен локальный CDP URL, например http://127.0.0.1:9222.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash
    || url.protocol !== (websocket ? 'ws:' : 'http:') || !url.port
    || (!websocket && url.pathname !== '/') || (websocket && !url.pathname.startsWith('/devtools/browser/'))) {
    throw new BrowserConnectionError('invalid_cdp_endpoint', 'Подключение разрешено только к локальному браузеру по CDP.');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href;
}
export async function discoverCdpEndpoints({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const roots = platform === 'darwin' ? [join(home, 'Library/Application Support/Google/Chrome'), join(home, 'Library/Application Support/Microsoft Edge'), join(home, 'Library/Application Support/Chromium')]
    : platform === 'win32' ? [join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'Google/Chrome/User Data'), join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'Microsoft/Edge/User Data')]
      : [join(home, '.config/google-chrome'), join(home, '.config/microsoft-edge'), join(home, '.config/chromium')];
  const endpoints = [];
  // Read only debugging-port metadata, never cookie/profile databases.
  for (const root of roots) {
    try {
      const file = join(root, 'DevToolsActivePort');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) continue;
      const [port, path] = (await readFile(file, 'utf8')).split('\n').map(line => line.trim());
      if (/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535) {
        // Chrome 144+ permission-based attachment may not expose /json/version.
        // Its actual WebSocket path is published in this metadata file.
        if (path?.startsWith('/devtools/browser/')) endpoints.push(localCdpEndpoint('ws://127.0.0.1:' + port + path, true));
        else endpoints.push('http://127.0.0.1:' + port + '/');
      }
    } catch { /* A normal browser often has no CDP port; try native automation on macOS. */ }
  }
  endpoints.push('http://127.0.0.1:9222/');
  return [...new Set(endpoints)];
}

export class AttachedContext extends EventEmitter {
  constructor(page, detach, metadata) {
    super(); this.page = page; this.detach = detach; this.metadata = metadata; this.owned = false; this.closed = false;
  }
  pages() { return [this.page]; }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.detach(); } finally { this.emit('close'); }
  }
}
async function connectCdp({ endpoint, provider, sourceTab, fetchImpl = fetch }) {
  let ws;
  if (endpoint.startsWith('ws:')) ws = localCdpEndpoint(endpoint, true);
  else {
    const base = localCdpEndpoint(endpoint);
    let version;
    try {
      const response = await fetchImpl(new URL('json/version', base), { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!response.ok) throw new Error('CDP status ' + response.status);
      const text = await response.text(); if (text.length > 16384) throw new Error('Unexpected CDP metadata');
      version = JSON.parse(text);
    } catch { throw new BrowserConnectionError('cdp_unavailable', 'Локальный CDP этого браузера недоступен.'); }
    ws = localCdpEndpoint(version.webSocketDebuggerUrl, true);
    if (new URL(ws).host !== new URL(base).host) throw new BrowserConnectionError('invalid_cdp_endpoint', 'CDP вернул другой сетевой адрес.');
  }
  let browser;
  try { browser = await chromium.connectOverCDP(ws, { timeout: 45000 }); }
  catch { throw new BrowserConnectionError('browser_automation_permission', 'Chrome не разрешил подключение. На chrome://inspect/#remote-debugging включите доступ и подтвердите запрос управления. Повторный вход в ChatGPT/Claude не нужен.'); }
  let work;
  try {
    const candidates = [];
    for (const context of browser.contexts()) for (const page of context.pages()) {
      if (!providerUrl(page.url(), provider)) continue;
      const cdp = await context.newCDPSession(page);
      let id;
      try { id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await cdp.detach(); }
      const focused = await page.evaluate(() => document.hasFocus()).catch(() => false);
      candidates.push({ id, url: page.url(), focused, page });
    }
    const source = chooseSource(candidates, sourceTab);
    // A new tab in the SAME browser context inherits its live login. No cookie copying.
    work = await source.page.context().newPage();
    const response = await work.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if ([401, 403, 429, 498].includes(response?.status())) {
      const error = new BrowserConnectionError('source_denied', 'HTTP ' + response.status() + ' при чтении существующей сессии.'); error.stopQueue = true; throw error;
    }
    if (!providerUrl(work.url(), provider)) throw new BrowserConnectionError('source_auth_required', 'Открытая сессия перенаправлена на вход. Войдите в исходной вкладке браузера и повторите.');
    return new AttachedContext(work, async () => {
      // Never close the user's browser context. Only our tab and our CDP connection.
      await work.close().catch(() => {}); await browser.close();
    }, { method: 'cdp-existing-session', source_tab: source.id });
  } catch (error) {
    await work?.close().catch(() => {}); await browser.close().catch(() => {}); throw error;
  }
}

export const JXA_SOURCE = `function run(argv) {
  const input=JSON.parse(argv[0]);
  const app=Application(input.app);
  if(!app.running()) return JSON.stringify({error:'browser_not_running'});
  const windows=app.windows();
  if(input.action==='list') {
    const tabs=[];
    for(let wi=0;wi<windows.length;wi++) {
      const win=windows[wi], rows=win.tabs(), active=win.activeTabIndex();
      for(let ti=0;ti<rows.length;ti++) {
        const url=rows[ti].url();
        if(url===input.origin || url.indexOf(input.origin+'/')===0) tabs.push({id:String(win.id())+':'+String(rows[ti].id()),windowId:win.id(),tabId:String(rows[ti].id()),url:url,focused:wi===0&&active===ti+1});
      }
    }
    return JSON.stringify({tabs:tabs});
  }
  const win=windows.find(w=>String(w.id())===String(input.windowId));
  if(!win) return JSON.stringify({error:'source_window_closed'});
  if(input.action==='create') {
    win.tabs.push(app.Tab({url:input.marker}));
    const matches=win.tabs().filter(t=>t.url()===input.marker);
    if(matches.length!==1) return JSON.stringify({error:'working_tab_not_identified'});
    const created=matches[0];
    return JSON.stringify({id:String(win.id())+':'+String(created.id()),windowId:win.id(),tabId:String(created.id())});
  }
  const tab=win.tabs().find(t=>String(t.id())===String(input.tabId));
  if(!tab) return JSON.stringify({error:'source_tab_closed'});
  if(input.action==='info') return JSON.stringify({url:tab.url(),loading:tab.loading()});
  if(input.action==='execute') return tab.execute({javascript:input.script});
  if(input.action==='navigate') { tab.url=input.url; return JSON.stringify({ok:true}); }
  if(input.action==='close') { tab.close(); return JSON.stringify({ok:true}); }
  return JSON.stringify({error:'unknown_action'});
}`;
export async function runJxa(input) {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SOURCE, JSON.stringify(input)], { timeout: 25000, maxBuffer: 32 * 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    if (result?.error) throw new BrowserConnectionError(result.error, 'Вкладка или окно браузера недоступны: ' + result.error);
    return result;
  } catch (error) {
    if (error instanceof BrowserConnectionError) throw error;
    const text = String(error.stderr || error.message);
    if (/JavaScript from Apple Events|Apple Events|javascript.*disabled|1743|10000/i.test(text)) {
      throw new BrowserConnectionError('browser_automation_permission', 'Разрешите управление браузером в настройках macOS. В Chrome: Вид → Разработчик → Разрешить JavaScript из событий Apple. Повторный вход в аккаунт не нужен.');
    }
    throw new BrowserConnectionError('native_automation_unavailable', 'Не удалось прочитать открытый браузер через штатную автоматизацию macOS.');
  }
}
export class NativeMacPage {
  constructor({ bridge, app, provider, reference }) { this.bridge = bridge; this.app = app; this.provider = provider; this.reference = reference; this.closed = false; }
  async request(action, fields = {}) {
    try { return await this.bridge({ app: this.app, action, ...this.reference, ...fields }); }
    catch (error) { if (['source_tab_closed', 'source_window_closed', 'browser_not_running'].includes(error.code)) { this.closed = true; error.stopQueue = true; } throw error; }
  }
  async url() { return (await this.request('info')).url; }
  isClosed() { return this.closed; }
  async evaluate(func, args) {
    if (!providerUrl(await this.url(), this.provider)) { const error = new BrowserConnectionError('source_changed', 'Рабочая вкладка сменила сайт или требует входа.'); error.stopQueue = true; throw error; }
    return this.request('execute', { script: 'JSON.stringify((' + func.toString() + ')(' + JSON.stringify(args) + '))' });
  }
  async goto(url, { timeout = 45000 } = {}) {
    if (!providerUrl(url, this.provider)) throw new BrowserConnectionError('invalid_source_url', 'Навигация допускается только внутри выбранного сервиса.');
    // Prefer an actual history link. React keeps its normal routing and fetch
    // behaviour, and our passive JSON observer survives the same-document route.
    let clicked = false;
    if (providerUrl(await this.url(), this.provider) && /\/(?:c|chat)\/[\w-]+\/?$/.test(new URL(url).pathname)) {
      const result = await this.evaluate(({ url }) => {
        const target = new URL(url);
        const link = [...document.querySelectorAll('aside a[href],nav a[href],[role="navigation"] a[href]')].find(el => {
          const actual = new URL(el.href);
          return actual.origin === target.origin && actual.pathname === target.pathname && !!el.getClientRects().length;
        });
        if (link && location.pathname !== target.pathname) { link.click(); return { clicked: true }; }
        return { clicked: false };
      }, { url });
      clicked = !!result?.clicked;
    }
    if (!clicked) await this.request('navigate', { url });
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const info = await this.request('info');
      if (info.url.startsWith('about:blank#chat-rescue-')) { await sleep(100); continue; }
      if (!providerUrl(info.url, this.provider)) { const error = new BrowserConnectionError('source_auth_required', 'Сессия требует входа в исходном браузере.'); error.stopQueue = true; throw error; }
      const expected = new URL(url), actual = new URL(info.url);
      // Apple Events can report loading=false for the PREVIOUS document after a URL assignment.
      const conversation = pathname => pathname.match(/\/(?:c|chat)\/([\w-]+)\/?$/)?.[1];
      const samePath = actual.pathname === expected.pathname || conversation(expected.pathname) && conversation(actual.pathname) === conversation(expected.pathname);
      if (!info.loading && actual.origin === expected.origin && samePath && Date.now() - started >= 500) return null;
      await sleep(100);
    }
    const error = new BrowserConnectionError('navigation_timeout', 'Браузер не подтвердил переход на запрошенную страницу.'); error.retryable = true; throw error;
  }
  locator(selector) {
    return { first: () => ({ waitFor: async ({ timeout }) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await this.evaluate(selector => !!document.querySelector(selector), selector)) return;
        await sleep(200);
      }
      throw new Error('Сообщения ещё не загружены.');
    } }) };
  }
  async close() { if (!this.closed) { this.closed = true; await this.request('close'); } }
}
export async function attachNativeMac({ provider, browser = 'chrome', sourceTab, bridge = runJxa }) {
  const app = APPS[browser];
  if (!app) throw new BrowserConnectionError('unsupported_browser', 'Нужен Chrome, Edge или Chromium.');
  const candidates = (await bridge({ app, action: 'list', origin: PROVIDERS[provider].origin })).tabs;
  const source = chooseSource(candidates, sourceTab);
  // Test the system permission on the source tab before making a new tab.
  await bridge({ app, action: 'execute', ...source, script: 'JSON.stringify({available:true})' });
  const reference = await bridge({ app, action: 'create', windowId: source.windowId, url: source.url, marker: 'about:blank#chat-rescue-' + randomUUID() });
  const page = new NativeMacPage({ bridge, app, provider, reference });
  try {
    await page.goto(source.url);
    return new AttachedContext(page, () => page.close(), { method: 'macos-existing-session', source_tab: source.id });
  } catch (error) { await page.close().catch(() => {}); throw error; }
}
export async function attachExistingBrowser({ provider, browser = 'chrome', cdpEndpoint, sourceTab } = {}) {
  if (cdpEndpoint) return connectCdp({ endpoint: cdpEndpoint, provider, sourceTab });
  let last;
  for (const endpoint of await discoverCdpEndpoints()) {
    try { return await connectCdp({ endpoint, provider, sourceTab }); }
    catch (error) {
      if (['source_tab_required', 'source_tab_not_found', 'source_denied', 'source_auth_required', 'invalid_cdp_endpoint', 'browser_automation_permission'].includes(error.code)) throw error;
      last = error;
    }
  }
  if (process.platform === 'darwin') return attachNativeMac({ provider, browser, sourceTab });
  throw new BrowserConnectionError('browser_connection_required', 'Разрешите управление уже открытым Chrome: chrome://inspect/#remote-debugging → включить доступ, затем подтвердить запрос подключения. Поддерживается Chrome 144+. Повторный вход в аккаунт не нужен. Уже разрешённый CDP можно указать через --cdp.', { previous: last?.code });
}

// No chat text or credentials are returned by this readiness probe.
export function inspectExistingScreen({ provider }) {
  const selectors = provider === 'chatgpt' ? '[data-message-author-role], article[data-testid^="conversation-turn-"], article[data-turn="user"], article[data-turn="assistant"], [data-role="user"], [data-role="assistant"]' : '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response';
  const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const messages = [...document.querySelectorAll(selectors)].filter(visible).length;
  const links = [...document.querySelectorAll('aside a[href], nav a[href], [role="navigation"] a[href], main a[href]')].filter(node => {
    if (!visible(node)) return false;
    try { const url = new URL(node.href); return url.origin === location.origin && /\/(?:c|chat)\/[\w-]+\/?$/.test(url.pathname); } catch { return false; }
  }).length;
  const authRoute = /\/(?:auth|login|signin)(?:\/|$)/i.test(location.pathname);
  const modal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].filter(visible)
    .some(node => /войти|log in|sign in|continue with google|продолжить с помощью google/i.test(node.innerText));
  const onChat = /\/(?:c|chat)\/[\w-]+\/?$/.test(location.pathname);
  const main = document.querySelector('main, [role="main"]');
  const loginButton = !messages && !links && [...document.querySelectorAll('a[href*="/auth/login"],button[data-testid="login-button"]')].some(visible);
  return { observable: messages > 0 || links > 0 || onChat && !!main && !loginButton, messages, links, auth_barrier: authRoute || modal || loginButton };
}
export async function waitForExistingScreen(page, provider, { timeout = 15000, interval = 200 } = {}) {
  const started = Date.now(); let screen;
  do {
    screen = await page.evaluate(inspectExistingScreen, { provider });
    if (screen.auth_barrier || screen.observable) return screen;
    await sleep(interval);
  } while (Date.now() - started < timeout);
  return screen;
}
