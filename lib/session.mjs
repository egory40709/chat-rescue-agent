import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROVIDERS, chatUrl, captureChat, discoverChats } from './engine.mjs';
import { discoverPage } from './dom.mjs';
import { sha256, slug, atomicWrite, openArchive, saveManifest, saveChat, savedIntact } from './archive.mjs';
import { acquireLock } from './lock.mjs';
import { packArchive } from './pack.mjs';
import { attachExistingBrowser, waitForExistingScreen, providerUrl } from './existing-browser.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertRunning = signal => { if (signal.aborted) throw new Error('Остановлено сотрудником или агентом.'); };
const BROWSERS = ['chrome', 'msedge', 'chromium'];
export const defaultOut = (provider, workspace) => join(homedir(), 'Downloads', 'chat-rescue', provider, slug(workspace) + '-' + sha256(workspace).slice(0, 8));

export class ExportSession {
  constructor({ launch, attach = attachExistingBrowser, defaultConnection = 'existing', engineOptions = {}, profileRoot = join(homedir(), '.chat-rescue-agent', 'profiles'), controlTransport = 'mcp' } = {}) {
    this.launch = launch || (options => chromium.launchPersistentContext(options.profile, {
      channel: options.browser === 'chromium' ? undefined : options.browser,
      headless: false, acceptDownloads: false, chromiumSandbox: true,
      viewport: { width: 1440, height: 1000 },
    }));
    this.engineOptions = engineOptions;
    this.attach = attach;
    this.defaultConnection = defaultConnection;
    this.profileRoot = profileRoot;
    this.controlTransport = controlTransport;
    this.writes = Promise.resolve();
    this.job = null;
    this.closed = false;
  }
  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = this.writes.catch(() => {}).then(() => atomicWrite(this.runFile, snapshot));
    this.writes = write;
    await write;
  }
  async open({ provider, workspace, browser = 'chrome', out, connection = this.defaultConnection, cdp_endpoint, source_tab, auto_start, initial_options = {} } = {}) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('provider: chatgpt или claude.');
    if (typeof workspace !== 'string' || !workspace.trim() || workspace.length > 120) throw new Error('Нужна метка собственного аккаунта и рабочего пространства, до 120 символов.');
    if (!BROWSERS.includes(browser)) throw new Error('browser: chrome, msedge или chromium.');
    if (!['existing', 'isolated'].includes(connection)) throw new Error('connection: existing или isolated.');
    if (this.context) {
      if (this.state.provider === provider && this.state.workspace === workspace && this.state.connection === connection && (!out || resolve(out) === this.out)) {
        if (connection === 'existing' && (auto_start ?? true) && !this.job) return this.start({ ...initial_options, user_ready: true });
        return this.status();
      }
      throw new Error('Сначала закройте текущую сессию, затем откройте другой сервис/аккаунт.');
    }
    this.out = resolve(out || defaultOut(provider, workspace));
    this.release = await acquireLock(this.out);
    try {
      this.manifest = await openArchive(this.out, provider, workspace);
      this.runFile = join(this.out, 'run.json');
      let previous;
      try { previous = JSON.parse(await readFile(this.runFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('run.json повреждён; выберите новую папку.'); }
      if (previous && (previous.version !== 1 || previous.provider !== provider || previous.workspace !== workspace)) throw new Error('run.json принадлежит другому архиву.');
      this.state = {
        version: 1, session_id: randomUUID(), pid: process.pid, provider, workspace, browser, connection, control_transport: this.controlTransport,
        out: this.out, run_file: this.runFile, phase: 'opening', coverage: 'unverified',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        last_error: null, current_id: null, job_id: null, zip: previous?.zip || null,
        selected_scope_confirmed_by_user: false, last_options: previous?.last_options || null, stop_reason: null,
      };
      if (connection === 'existing') this.state.next_action = 'Подключаю открытую вкладку. Если Chrome покажет запрос управления, разрешите его; повторный вход не нужен.';
      await this.persist();
      if (connection === 'existing') {
        this.context = await this.attach({ provider, browser, cdpEndpoint: cdp_endpoint, sourceTab: source_tab });
        this.state.attachment = this.context.metadata;
      } else {
        const profile = join(this.profileRoot, provider, slug(workspace) + '-' + sha256(workspace).slice(0, 12));
        await mkdir(profile, { recursive: true, mode: 0o700 });
        this.context = await this.launch({ profile, provider, browser });
      }
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.context.on('close', () => { this.contextClosed = true; if (this.state) this.state.stop_reason ||= 'browser_closed'; this.controller?.abort(); });
      if (connection === 'existing') {
        const screen = await waitForExistingScreen(this.page, provider);
        if (screen.auth_barrier || !screen.observable) {
          const error = new Error(screen.auth_barrier ? 'Исходная вкладка требует входа. Используйте уже авторизованную вкладку нужного аккаунта.' : 'В открытой вкладке не найдены доступные чаты. Раскройте историю или откройте известный диалог.');
          error.code = screen.auth_barrier ? 'source_auth_required' : 'source_not_ready';
          throw error;
        }
        this.state.phase = 'ready';
        this.state.selected_scope_confirmed_by_user = true;
        this.state.next_action = 'Существующая вкладка подключена. Выгрузка запускается автоматически.';
      } else {
        try {
          const response = await this.page.goto(PROVIDERS[provider].start, { waitUntil: 'domcontentloaded', timeout: 60000 });
          this.state.initial_http_status = response?.status() ?? null;
        } catch (error) { this.state.last_error = 'Страница требует ручного открытия: ' + error.name; }
        this.state.phase = 'awaiting_login';
        this.state.next_action = 'В выбранном isolated режиме сотрудник входит в отдельном браузере, затем агент вызывает start_export с user_ready=true.';
      }
      await this.persist();
      if (auto_start ?? connection === 'existing') await this.start({ ...initial_options, user_ready: true });
      return this.status();
    } catch (error) {
      if (this.state && this.runFile) {
        this.state.phase = 'failed'; this.state.last_error = error.message; this.state.error_code = error.code || null;
        if (error.details) this.state.connection_details = error.details;
        await this.persist().catch(() => {});
      }
      await this.context?.close().catch(() => {}); this.context = null;
      await this.release(); this.release = null;
      throw error;
    }
  }
  async status() {
    if (!this.state) throw new Error('Сначала откройте сессию.');
    const counts = { pending: 0, saved: 0, partial: 0, failed: 0 };
    for (const entry of Object.values(this.manifest.chats)) counts[entry.status] = (counts[entry.status] || 0) + 1;
    return {
      ...this.state, counts, total: Object.keys(this.manifest.chats).length,
      issues: Object.entries(this.manifest.chats).filter(([, entry]) => ['partial', 'failed'].includes(entry.status))
        .slice(0, 100).map(([id, entry]) => ({ id, status: entry.status, error: entry.error, warnings: entry.warnings || [] })),
      last_discovery: this.manifest.discoveries.length ? {
        reason: this.manifest.discoveries.at(-1).reason,
        observed_links: this.manifest.discoveries.at(-1).links?.length || 0, complete: false,
      } : null,
      manifest_file: join(this.out, 'manifest.json'), index_file: join(this.out, 'INDEX.md'),
      browser_open: !!this.context && !this.contextClosed,
      limitations: ['Полнота истории не подтверждена', 'Сохраняется отображённый текст выбранной ветки', 'Вложения, изображения, Canvas/Artifacts и файлы проектов отдельно не скачаны'],
    };
  }
  async inspect() {
    const status = await this.status();
    if (!this.page || this.page.isClosed()) return { ...status, browser_open: false };
    const url = await this.page.url();
    const originMatches = (() => { try { return new URL(url).origin === PROVIDERS[this.state.provider].origin; } catch { return false; } })();
    if (!originMatches) return { ...status, on_provider_site: false, ui_chat_links: 0, current_chat: null };
    const observed = await this.page.evaluate(discoverPage, { provider: this.state.provider });
    return { ...status, on_provider_site: true, ui_chat_links: observed.links.length, current_chat: chatUrl(url, this.state.provider),
      login_verified: false, workspace_verified: false };
  }
  async start({ user_ready, mode = 'all', urls = [], refresh = false, limit = 1000, max_scrolls = 200, list_scrolls = 200, delay_ms = 1500 } = {}) {
    if (this.job || this.starting) return this.status();
    if (!this.context || this.contextClosed || this.closed) throw new Error('Откройте новую сессию браузера.');
    if (user_ready !== true && this.state.connection !== 'existing') throw new Error('В isolated режиме нужно сообщение сотрудника о входе и выборе workspace; затем user_ready=true.');
    if (!['all', 'current', 'urls', 'resume'].includes(mode)) throw new Error('mode: all, current, urls или resume.');
    for (const [value, name, min, max] of [[limit, 'limit', 1, 100000], [max_scrolls, 'max_scrolls', 12, 5000], [list_scrolls, 'list_scrolls', 10, 5000], [delay_ms, 'delay_ms', 1000, 60000]]) {
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(name + ': допустимо целое от ' + min + ' до ' + max);
    }
    if (!Array.isArray(urls) || urls.length > 100000) throw new Error('urls должен быть массивом ссылок.');
    const targets = urls.map(url => {
      const target = typeof url === 'string' && url.startsWith('https://') ? chatUrl(url, this.state.provider) : null;
      if (!target) throw new Error('Недопустимая ссылка: нужны HTTPS-чаты выбранного сервиса.');
      return target;
    });
    if (mode === 'urls' && !targets.length) throw new Error('Для mode=urls нужны ссылки.');
    const options = { mode, urls: targets.map(t => t.url), refresh, limit, max_scrolls, list_scrolls, delay_ms };
    this.starting = true;
    this.controller = new AbortController();
    this.state.selected_scope_confirmed_by_user = true;
    this.state.last_options = options;
    this.state.job_id = randomUUID(); this.state.last_error = null; this.state.zip = null; this.state.stop_reason = null;
    this.state.phase = mode === 'all' ? 'discovering' : 'exporting';
    this.state.next_action = 'Опросить get_export_status; при завершении предоставить путь к ZIP и отметить ограничения.';
    this.state.updated_at = new Date().toISOString();
    try { await this.persist(); } catch (error) { this.starting = false; throw error; }
    this.job = this.run(options, targets, this.controller.signal).catch(async error => {
      this.state.phase = this.controller.signal.aborted ? 'paused' : error.stopQueue ? 'blocked' : 'failed';
      this.state.last_error = error.message; this.state.current_id = null;
      await saveManifest(this.out, this.manifest);
      await this.persist();
    }).finally(() => { this.job = null; });
    this.starting = false;
    return this.status();
  }
  async run(options, targets, signal) {
    const provider = this.state.provider;
    if (!providerUrl(await this.page.url(), provider)) throw new Error('Исходная вкладка сменила сервис или рабочее пространство.');
    let discovery;
    if (options.mode === 'all') discovery = await discoverChats(this.page, provider, { maxScrolls: options.list_scrolls, signal, ...this.engineOptions });
    else if (options.mode === 'current') {
      const current = chatUrl(await this.page.url(), provider);
      if (!current) throw new Error('Для current откройте нужный диалог в первой вкладке.');
      discovery = { links: [current], reason: 'current-chat', complete: false };
    } else if (options.mode === 'urls') discovery = { links: targets, reason: 'provided-urls', complete: false };
    else discovery = { links: [], reason: 'resume-existing-queue', complete: false };
    assertRunning(signal);
    this.manifest.discoveries.push({ ...discovery, at: new Date().toISOString() });
    for (const target of discovery.links) if (!Object.hasOwn(this.manifest.chats, target.id)) this.manifest.chats[target.id] = { ...target, status: 'pending' };
    await saveManifest(this.out, this.manifest);
    const queue = ['current', 'urls'].includes(options.mode) ? discovery.links
      : Object.entries(this.manifest.chats).filter(([, e]) => e.url).map(([id, e]) => ({ id, url: e.url, title: e.title }));
    const unique = [...new Map(queue.map(target => [target.id, target])).values()];
    if (!unique.length) throw new Error('Нет ссылок. Раскройте боковую историю, откройте список Claude или передайте urls.');
    this.state.phase = 'exporting'; await this.persist();
    let attempted = 0, consecutive = 0, limited = false;
    for (const target of unique) {
      assertRunning(signal);
      if (!options.refresh && await savedIntact(this.out, this.manifest.chats[target.id])) continue;
      if (attempted >= options.limit) { limited = true; break; }
      this.state.current_id = target.id; this.state.updated_at = new Date().toISOString(); await this.persist();
      attempted++;
      try {
        const chat = await captureChat(this.page, provider, target, { signal, maxScrolls: options.max_scrolls,
          navigate: !(options.mode === 'current' && attempted === 1), ...this.engineOptions });
        await saveChat(this.out, this.manifest, chat);
        consecutive = chat.warnings.length ? consecutive + 1 : 0;
      } catch (error) {
        if (signal.aborted) throw error;
        this.manifest.chats[target.id] = { ...this.manifest.chats[target.id], ...target, status: 'failed', error: error.message };
        await saveManifest(this.out, this.manifest); consecutive++;
        if (error.stopQueue || this.page.isClosed()) throw error;
      }
      await this.persist();
      if (consecutive >= 3) throw new Error('Три ошибки/неполных результата подряд. Нужна проверка входа или интерфейса.');
      if (this.engineOptions.delayMs !== undefined) await sleep(this.engineOptions.delayMs);
      else await sleep(options.delay_ms);
    }
    assertRunning(signal);
    this.state.current_id = null;
    this.state.zip = await packArchive(this.out, this.manifest);
    const selected = unique.map(t => this.manifest.chats[t.id]);
    this.state.phase = limited ? 'paused' : selected.some(e => e.status !== 'saved') || this.state.zip.integrity_issues.length ? 'needs_review' : 'complete';
    this.state.stop_reason = limited ? 'limit_reached' : null;
    this.state.updated_at = new Date().toISOString();
    this.state.next_action = limited ? 'Продолжить очередь через resume_export; достигнут limit.' : 'Предоставить сотруднику ZIP, INDEX.md, числа saved/partial/failed и границы полноты.';
    await this.persist();
  }
  async stop() {
    this.state.stop_reason = 'user_requested';
    if (this.job) { this.controller.abort(); this.state.next_action = 'Остановка запрошена; опросить get_export_status.'; }
    else { this.state.phase = 'paused'; await this.persist(); }
    return this.status();
  }
  async resume({ user_ready = false, limit = 1000 } = {}) {
    return this.start({ ...(this.state.last_options || {}), mode: 'resume', refresh: false, user_ready, limit });
  }
  async pack() {
    if (this.job) throw new Error('Дождитесь окончания или остановите активную очередь.');
    this.state.zip = await packArchive(this.out, this.manifest); await this.persist();
    return this.status();
  }
  async close() {
    if (this.closed) return this.state ? this.status() : null;
    this.controller?.abort();
    // Existing-session adapters close only our tab and connection, never the user's browser.
    await this.context?.close().catch(() => {});
    if (this.job) await this.job;
    this.closed = true;
    if (this.state) {
      this.state.browser_closed = this.state.connection !== 'existing' && !!this.context;
      this.state.detached = this.state.connection === 'existing' && !!this.context;
      if (['opening', 'ready', 'awaiting_login', 'discovering', 'exporting'].includes(this.state.phase)) this.state.phase = 'paused';
      await this.persist();
    }
    if (this.release) { await this.release(); this.release = null; }
    return this.state ? this.status() : null;
  }
}
