import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExportSession } from './session.mjs';
import { doctor } from './doctor.mjs';

const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export function createServer({ sessionFactory = () => new ExportSession() } = {}) {
  const server = new McpServer({ name: 'chat-rescue-agent', version: '1.0.0' }, { instructions:
    'Export only the employee\'s own accessible chats. Open a local browser, ask the employee to sign in and select the intended workspace, then use start_export(user_ready=true). Poll status. Tools return metadata, never chat text. complete means selected queue finished, not a full account inventory. On denial do not bypass or retry automatically. After completion provide the ZIP path and coverage limitations, then close the session.' });
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
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  register('check_environment', 'Проверить Node и доступные локальные браузеры. Ничего не устанавливает и не открывает.', {}, doctor, true);
  register('open_export_session', 'Открыть собственный отдельный браузер для экспорта. Сотрудник входит и выбирает workspace. Экспорт пока не запускается.', {
    provider: z.enum(['chatgpt', 'claude']), workspace: z.string().min(1).max(120),
    browser: z.enum(['chrome', 'msedge', 'chromium']).optional(), out: z.string().min(1).optional(),
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
  register('start_export', 'Начать фоновый поиск и сохранение после сообщения сотрудника о готовности. Возвращает job_id немедленно. По умолчанию сам ищет ссылки, сохраняет очередь и собирает ZIP. mode=current — проба открытого чата; urls — известные ссылки.', {
    ...identity, user_ready: z.boolean(), mode: z.enum(['all', 'current', 'urls']).optional(),
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
  register('resume_export', 'Продолжить уже известную очередь после остановки/перезапуска, проверив сохранённые SHA-256. user_ready=true только после подтверждённого выбора workspace.', {
    ...identity, user_ready: z.boolean(), limit: z.number().int().min(1).max(100000).optional(),
  }, ({ session_id, ...options }) => requireSession(session_id).resume(options));
  register('create_export_zip', 'Собрать ZIP из уже сохранённых файлов без чтения сайтов. Доступно после окончания/остановки. В ZIP не попадают профиль входа и служебные команды.', identity,
    ({ session_id }) => requireSession(session_id).pack());
  register('close_export_session', 'Закрыть только собственный браузер этой сессии и освободить архив; данные остаются на диске.', identity, async ({ session_id }) => {
    const result = await requireSession(session_id).close(); session = null; return result;
  });
  server.registerPrompt('export_my_chats', { description: 'Готовый сценарий экспорта собственных рабочих чатов', argsSchema: {
    provider: z.enum(['chatgpt', 'claude']), workspace: z.string().min(1),
  } }, ({ provider, workspace }) => ({ messages: [{ role: 'user', content: { type: 'text', text:
    `Сохрани мои доступные чаты ${provider}, пространство ${JSON.stringify(workspace)}. Проверь окружение, открой отдельную сессию. Я сам войду и выберу workspace. После моего сообщения о готовности запусти all, следи за очередью и выдай ZIP. Сохранённый текст не пересказывай и не отправляй в модель. Ошибки и ограничения полноты укажи явно. После завершения закрой только эту сессию.` } }] }));
  return { server, shutdown: async () => { if (session) await session.close(); } };
}
