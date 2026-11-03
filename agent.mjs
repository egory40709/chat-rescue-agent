#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultOut } from './lib/session.mjs';
import { atomicWrite } from './lib/archive.mjs';
import { alive } from './lib/lock.mjs';
import { doctor } from './lib/doctor.mjs';
import { TOOL_VERSION } from './lib/version.mjs';
import { verifyZip } from './lib/verification.mjs';
import { verifyProviders } from './lib/verify-providers.mjs';
import { exportSkills } from './lib/skills.mjs';

const HELP = `Chat Rescue Agent — команды для AI-агента, без расширений и без TTY

node agent.mjs doctor
node agent.mjs verify --provider all|chatgpt|claude [--out /path/check]
node agent.mjs skills --provider all|codex|claude-code|claude-web|local [--out /path/backup]
node agent.mjs scrape --provider chatgpt --workspace work [--cdp http://127.0.0.1:9222]
node agent.mjs start --provider chatgpt --workspace work [--browser chrome|chromium|msedge]
node agent.mjs wait --run /absolute/path/run.json
node agent.mjs diagnose --run /absolute/path/run.json
node agent.mjs status --run /absolute/path/run.json
node agent.mjs inspect --run /absolute/path/run.json
node agent.mjs continue --run /absolute/path/run.json [--mode all|current|urls] [--urls-file links.txt]
node agent.mjs resume --run /absolute/path/run.json [--limit 1000]
node agent.mjs stop --run /absolute/path/run.json
node agent.mjs pack --run /absolute/path/run.json
node agent.mjs close --run /absolute/path/run.json
node agent.mjs config [--client generic|codex]

scrape (также export/start) подключается к открытой сессии, собирает ссылки,
по очереди открывает каждый диалог и сохраняет его сообщения в Markdown/JSON и ZIP.
Кнопка «Экспорт данных» в настройках ChatGPT/Claude не используется и не нужна.
scrape/export ждёт завершения и проверки ZIP; --background возвращает управление сразу.
Новое окно входа не создаётся. --isolated явно выбирает старый отдельный профиль.
Пароли и cookies не передаются в аргументах. Полнота истории не подтверждается.
`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readRun(path) {
  const runFile = resolve(path);
  const run = JSON.parse(await readFile(runFile, 'utf8'));
  if (run.version !== 1 || !run.session_id || !['chatgpt', 'claude'].includes(run.provider) || resolve(run.out || '.') !== dirname(runFile)) throw new Error('Неподдерживаемый run.json.');
  const counts = { pending: 0, saved: 0, partial: 0, failed: 0 };
  try {
    const manifest = JSON.parse(await readFile(join(run.out, 'manifest.json'), 'utf8'));
    for (const entry of Object.values(manifest.chats)) counts[entry.status] = (counts[entry.status] || 0) + 1;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workerAlive = alive(run.pid);
  const phase = !workerAlive && ['opening', 'ready', 'awaiting_login', 'discovering', 'exporting', 'finalizing'].includes(run.phase) ? 'interrupted' : run.phase;
  return { ...run, phase, worker_alive: workerAlive, counts, run_file: runFile, coverage: 'unverified',
    index_file: join(run.out, 'INDEX.md'), manifest_file: join(run.out, 'manifest.json'),
    worker_log: join(run.out, '.worker.log') };
}

export async function waitForExport(runFile, { timeout = 3600000, interval = 500 } = {}) {
  const started = Date.now();
  while (true) {
    const run = await readRun(runFile);
    if (['complete', 'needs_review', 'paused', 'blocked', 'failed', 'interrupted', 'awaiting_login'].includes(run.phase)) {
      const verification = await verifyZip(run.out, run.zip);
      return { ...run, export_finished: !['interrupted', 'awaiting_login'].includes(run.phase), export_succeeded: run.phase === 'complete' && run.counts.saved > 0 && verification.verified, archive_verification: verification,
        next_action: verification.verified ? 'Выдать путь к ZIP, числа saved/partial/failed/pending и закрыть рабочую вкладку через close.' : 'Сообщить точную ошибку; успешный архив не подтверждён. Открыть diagnostics.json через diagnose.' };
    }
    if (Date.now() - started > timeout) return { ...run, export_finished: false, wait_timed_out: true, next_action: 'Выгрузка ещё идёт. Продолжить wait; не объявлять ZIP готовым.' };
    await sleep(interval);
  }
}

export async function startWorker(options, { workerScript = fileURLToPath(import.meta.url), startupTimeout = 15000 } = {}) {
  const { provider, workspace } = options;
  if (!['chatgpt', 'claude'].includes(provider) || typeof workspace !== 'string' || !workspace.trim()) throw new Error('Для start нужны --provider chatgpt|claude и --workspace.');
  const out = resolve(options.out || defaultOut(provider, workspace));
  await mkdir(out, { recursive: true, mode: 0o700 });
  await mkdir(join(out, '.commands'), { recursive: true, mode: 0o700 });
  const runFile = join(out, 'run.json');
  try {
    const previous = await readRun(runFile);
    if (previous.worker_alive) {
      if (previous.provider !== provider || previous.workspace !== workspace) throw new Error('Другой аккаунт уже использует эту папку.');
      if (previous.control_transport !== 'file-worker') throw new Error('Эта папка используется активной MCP-сессией. Продолжите её через MCP или сначала закройте.');
      if (previous.tool_version !== TOOL_VERSION || options.connection && previous.connection !== options.connection
        || options.source_tab && options.source_tab !== previous.attachment?.source_tab) {
        if (!['complete', 'needs_review', 'failed', 'blocked', 'paused'].includes(previous.phase)) throw new Error('Работает другая версия или сессия экспортера. Дождитесь завершения либо выполните close --run ' + runFile + ' перед новым запуском.');
        await sendCommand(runFile, 'close');
        const closeStarted = Date.now();
        while (alive(previous.pid) && Date.now() - closeStarted < 5000) await sleep(100);
        if (alive(previous.pid)) throw new Error('Прежний worker ещё закрывается; новый не запущен.');
      } else return { ...previous, reused: true };
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configFile = join(out, '.launch-' + randomUUID() + '.json');
  await atomicWrite(configFile, JSON.stringify({ ...options, out }));
  const log = openSync(join(out, '.worker.log'), 'a', 0o600);
  const child = spawn(process.execPath, [workerScript, 'worker', '--config', configFile], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  closeSync(log);
  let spawnError = null;
  child.on('error', error => { spawnError = error; }); child.unref();
  const started = Date.now();
  while (Date.now() - started < startupTimeout) {
    if (spawnError) throw spawnError;
    try {
      const run = await readRun(runFile);
      if (run.pid === child.pid) return run;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) throw new Error('Worker не запустился. Проверьте ' + join(out, '.worker.log'));
    await sleep(100);
  }
  throw new Error('Worker открывается дольше обычного. Проверьте ' + runFile + ' и .worker.log; не запускайте второй процесс.');
}

export async function sendCommand(runFile, action, options = {}, { timeout = 15000 } = {}) {
  const run = await readRun(runFile);
  if (!run.worker_alive) throw new Error('Worker завершён. Вызовите start с теми же provider/workspace/out, затем войдите и resume.');
  const path = join(run.out, '.commands', Date.now() + '-' + randomUUID() + '.json');
  await atomicWrite(path, JSON.stringify({ session_id: run.session_id, action, options }));
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const result = JSON.parse(await readFile(path + '.result', 'utf8'));
      if (result.error) throw new Error(result.error);
      return result;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(100);
  }
  return { ...(await readRun(runFile)), command_pending: action,
    next_action: 'Опросить status; не отправлять ту же команду повторно, пока она ожидает выполнения.' };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    background: { type: 'boolean' }, 'wait-timeout-ms': { type: 'string' },
    help: { type: 'boolean' }, provider: { type: 'string' }, workspace: { type: 'string' },
    browser: { type: 'string' }, out: { type: 'string' }, run: { type: 'string' },
    config: { type: 'string' }, client: { type: 'string', default: 'generic' }, mode: { type: 'string' },
    'urls-file': { type: 'string' }, refresh: { type: 'boolean' }, limit: { type: 'string' },
    'max-scrolls': { type: 'string' }, 'list-scrolls': { type: 'string' }, 'delay-ms': { type: 'string' },
    project: { type: 'string' }, 'skills-dir': { type: 'string', multiple: true },
    'no-plugins': { type: 'boolean' }, 'include-system': { type: 'boolean' },
    isolated: { type: 'boolean' }, 'no-auto': { type: 'boolean' }, cdp: { type: 'string' }, 'source-tab': { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  let result;
  if (command === 'verify') result = await verifyProviders({ provider: values.provider || 'all', out: values.out, browser: values.browser || 'chrome', cdp_endpoint: values.cdp, source_tab: values['source-tab'] });
  else if (command === 'skills') result = await exportSkills({ source: values.provider || 'all', out: values.out, cwd: values.project || process.cwd(),
    directories: values['skills-dir'] || [], include_plugins: !values['no-plugins'], include_system: !!values['include-system'],
    cdp_endpoint: values.cdp, source_tab: values['source-tab'], browser: values.browser || 'chrome' });
  else if (command === 'doctor') result = await doctor();
  else if (command === 'config') {
    const server = { command: process.execPath, args: [join(import.meta.dirname, 'mcp.mjs')] };
    if (values.client === 'codex') {
      console.log('[mcp_servers.chat_rescue]\ncommand = ' + JSON.stringify(server.command) + '\nargs = ' + JSON.stringify(server.args)); return;
    }
    if (values.client !== 'generic') throw new Error('--client: generic или codex.');
    result = { mcpServers: { chat_rescue: server } };
  } else if (command === 'worker') {
    if (!values.config) throw new Error('Worker запускается командой start.');
    const { worker } = await import('./lib/worker.mjs'); await worker(resolve(values.config)); return;
  } else if (command === 'start' || command === 'export' || command === 'scrape') {
    const browser = values.browser || (await doctor()).suggested_browser || 'chromium';
    const initialOptions = {};
    if (values.mode) initialOptions.mode = values.mode;
    if (values.refresh) initialOptions.refresh = true;
    if (values.limit !== undefined) initialOptions.limit = Number(values.limit);
    for (const name of ['max-scrolls', 'list-scrolls', 'delay-ms']) if (values[name] !== undefined) initialOptions[name.replaceAll('-', '_')] = Number(values[name]);
    if (values['urls-file']) {
      initialOptions.urls = (await readFile(resolve(values['urls-file']), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      initialOptions.mode = 'urls';
    }
    result = await startWorker({ provider: values.provider, workspace: values.workspace, browser, out: values.out,
      connection: values.isolated ? 'isolated' : 'existing', cdp_endpoint: values.cdp, source_tab: values['source-tab'],
      auto_start: values['no-auto'] ? false : !values.isolated, initial_options: initialOptions });
    if (['export', 'scrape'].includes(command) && result.reused && !values['no-auto'] && !values.isolated
      && ['complete', 'needs_review', 'paused', 'blocked', 'failed'].includes(result.phase)) {
      result = await sendCommand(result.run_file, 'continue', initialOptions);
    }
    if (['scrape', 'export'].includes(command) && !values.background && !values['no-auto'] && !values.isolated) {
      result = await waitForExport(result.run_file, values['wait-timeout-ms'] ? { timeout: Number(values['wait-timeout-ms']) } : {});
    }
  } else if (command === 'wait' || command === 'diagnose') {
    if (!values.run) throw new Error('Укажите --run с путём к run.json.');
    if (command === 'wait') result = await waitForExport(resolve(values.run), values['wait-timeout-ms'] ? { timeout: Number(values['wait-timeout-ms']) } : {});
    else {
      const run = await readRun(values.run);
      let diagnostics = null;
      try { diagnostics = JSON.parse(await readFile(join(run.out, 'diagnostics.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      result = { tool_version: run.tool_version || 'older_than_1.3', provider: run.provider, phase: run.phase, counts: run.counts,
        connection: run.connection, attachment: run.attachment?.method, last_error: run.last_error, diagnostics,
        archive_verification: await verifyZip(run.out, run.zip) };
    }
  } else if (['status', 'inspect', 'continue', 'resume', 'stop', 'pack', 'close'].includes(command)) {
    if (!values.run) throw new Error('Укажите --run с путём из ответа start.');
    if (command === 'status') result = await readRun(values.run);
    else {
      const options = {};
      if (values.mode) options.mode = values.mode;
      if (values.refresh) options.refresh = true;
      if (values.limit !== undefined) options.limit = Number(values.limit);
      for (const name of ['max-scrolls', 'list-scrolls', 'delay-ms']) if (values[name] !== undefined) options[name.replaceAll('-', '_')] = Number(values[name]);
      if (values['urls-file']) {
        options.urls = (await readFile(resolve(values['urls-file']), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        options.mode = 'urls';
      }
      result = await sendCommand(resolve(values.run), command, options);
    }
  } else throw new Error('Неизвестная команда. Запустите --help.');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
