import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExportSession } from './session.mjs';
import { doctor } from './doctor.mjs';

const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export function createServer({ sessionFactory = () => new ExportSession() } = {}) {
  const server = new McpServer({ name: 'chat-rescue-agent', version: '1.1.1' }, { instructions:
    'Export only the employee\'s own accessible chats. Read each conversation in turn and save its messages locally. Never click Settings > Export data or ask for that button; this tool does not use native account data export. By default open_export_session attaches to an already open local ChatGPT/Claude browser tab and automatically exports with its existing login, without another login or confirmation. It creates only a working tab in the same browser context. Poll status. Never silently fall back to an isolated profile. If browser automation needs permission or a tab choice, report that specific requirement. Tools return metadata, never chat text. complete means selected queue finished, not a full account inventory. On denial do not bypass or retry automatically. After completion detach only the exporter and leave the user\'s browser open.' });
  let session = null, opening = false;
  const requireSession = id => {
    if (!session || session.state?.session_id !== id) throw new Error('Сессия не найдена. Вызовите open_export_session заново.');
    return session;
  };
  function register(name, description, shape, handler, readOnly = false) {
    server.registerTool(name, { description, inputSchema: shape, annotations: {
      readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly,
    } }, async input => {
      try { return toolResult(await handler(input)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }],
        ...(error.code ? { structuredContent: { error: error.message, code: error.code, details: error.details || {} } } : {}) }; }
    });
  }
  register('check_environment', 'Проверить Node и доступные локальные браузеры. Ничего не устанавливает и не открывает.', {}, doctor, true);
  register('open_export_session', 'Подключиться к открытой локальной вкладке ChatGPT/Claude, собрать ссылки и по одной сохранить переписки в Markdown/JSON и ZIP. Кнопка «Экспорт данных» в настройках не нужна и не используется. Новое окно входа не создаётся. connection=isolated явно выбирает отдельный профиль; auto_start=false только подключает.', {
    provider: z.enum(['chatgpt', 'claude']), workspace: z.string().min(1).max(120),
    browser: z.enum(['chrome', 'msedge', 'chromium']).optional(), out: z.string().min(1).optional(),
    connection: z.enum(['existing', 'isolated']).optional(), auto_start: z.boolean().optional(),
    cdp_endpoint: z.string().min(1).optional(), source_tab: z.string().min(1).max(200).optional(),
    initial_options: z.object({ mode: z.enum(['all', 'current', 'urls', 'resume']).optional(), urls: z.array(z.string()).max(100000).optional(),
      refresh: z.boolean().optional(), limit: z.number().int().min(1).max(100000).optional(),
      max_scrolls: z.number().int().min(12).max(5000).optional(), list_scrolls: z.number().int().min(10).max(5000).optional(),
      delay_ms: z.number().int().min(1000).max(60000).optional() }).optional(),
  }, async input => {
    if (opening) throw new Error('Сессия уже открывается. Дождитесь результата первого вызова.');
    opening = true;
    try { session ||= sessionFactory(); return await session.open(input); }
    catch (error) { if (!session?.context) session = null; throw error; }
    finally { opening = false; }
  });
  const identity = { session_id: z.string().uuid() };
  register('inspect_export_session', 'Посмотреть готовность вкладки: только URL текущего чата и число ссылок, без содержания переписок. Не подтверждает login/workspace автоматически.', identity,
    ({ session_id }) => requireSession(session_id).inspect(), true);
  register('start_export', 'Начать или повторить фоновую выгрузку. В existing режиме подтверждение готовности не нужно. Для isolated нужен user_ready=true после входа. Возвращает job_id немедленно; сам ищет ссылки, сохраняет очередь и собирает ZIP.', {
    ...identity, user_ready: z.boolean().optional(), mode: z.enum(['all', 'current', 'urls']).optional(),
    urls: z.array(z.string()).max(100000).optional(), refresh: z.boolean().optional(),
    limit: z.number().int().min(1).max(100000).optional(),
    max_scrolls: z.number().int().min(12).max(5000).optional(),
    list_scrolls: z.number().int().min(10).max(5000).optional(),
    delay_ms: z.number().int().min(1000).max(60000).optional(),
  }, ({ session_id, ...options }) => requireSession(session_id).start(options));
  register('get_export_status', 'Быстро получить статус фоновой задачи, счётчики, ошибки, пути к архиву. Опрос раз в несколько секунд не читает сайты повторно.', identity,
    ({ session_id }) => requireSession(session_id).status(), true);
  register('stop_export', 'Остановить очередь по запросу сотрудника; сохранённые файлы остаются. После user_requested не возобновлять без его указания.', identity,
    ({ session_id }) => requireSession(session_id).stop());
  register('resume_export', 'Продолжить уже известную очередь с проверкой SHA-256. Существующая сессия не требует подтверждения входа; для isolated нужен user_ready=true.', {
    ...identity, user_ready: z.boolean().optional(), limit: z.number().int().min(1).max(100000).optional(),
  }, ({ session_id, ...options }) => requireSession(session_id).resume(options));
  register('create_export_zip', 'Собрать ZIP из уже сохранённых файлов без чтения сайтов. Доступно после окончания/остановки. В ZIP не попадают профиль входа и служебные команды.', identity,
    ({ session_id }) => requireSession(session_id).pack());
  register('close_export_session', 'Закрыть свою рабочую вкладку и подключение, оставив исходный браузер открытым. В isolated режиме закрывается отдельный браузер инструмента.', identity, async ({ session_id }) => {
    const result = await requireSession(session_id).close(); session = null; return result;
  });
  server.registerPrompt('export_my_chats', { description: 'Готовый сценарий экспорта собственных рабочих чатов', argsSchema: {
    provider: z.enum(['chatgpt', 'claude']), workspace: z.string().min(1),
  } }, ({ provider, workspace }) => ({ messages: [{ role: 'user', content: { type: 'text', text:
    `Сохрани мои доступные чаты ${provider}, пространство ${JSON.stringify(workspace)}. Используй мою уже открытую локальную вкладку и её текущий вход: open_export_session с connection=existing автоматически запускает all. Не создавай отдельное окно входа и не запрашивай повторное подтверждение готовности. Если недоступно управление браузером, сообщи нужное разрешение. По очереди открой каждый найденный чат и сохрани сообщения через готовый инструмент. Не нажимай «Экспорт данных» и не ищи эту кнопку в настройках: она не участвует в сборе. Следи за очередью и выдай ZIP. Сохранённый текст не пересказывай и не отправляй в модель. Ошибки и ограничения полноты укажи явно. После завершения отключи только инструмент, оставив исходный браузер открытым.` } }] }));
  return { server, shutdown: async () => { if (session) await session.close(); } };
}
