export function toMarkdown(chat) {
  const lines = [
    '# ' + String(chat.title || chat.id).replace(/[\r\n]/g, ' '), '',
    'Источник: ' + (chat.url || chat.provider), '',
    'Сохранено: ' + chat.capturedAt, '',
    'Способ: ' + chat.method, '',
    'Ограничения: ' + chat.limitations.join('; '), '',
  ];
  for (const warning of chat.warnings || []) lines.push('ПРОВЕРИТЬ: ' + warning, '');
  for (const message of chat.messages) {
    lines.push('## ' + (message.role === 'user' ? 'Сотрудник' : message.role === 'assistant' ? 'Ассистент' : message.role), '', message.markdown || message.text || '', '');
  }
  if (!chat.messages.length && chat.fallbackText) lines.push('## Неразобранный текст страницы', '', chat.fallbackText, '');
  return lines.join('\n');
}
