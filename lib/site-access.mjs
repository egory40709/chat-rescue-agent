// Fixed public markers only. Never retain the error page's IP, Ray ID or HTML.
// The leading '<' prevents a quoted error page inside a JSON chat from matching.
export const UNAVAILABLE_HTML_PATTERNS = [
  '^\\s*<',
  'class\\s*=\\s*["\'][^"\']*\\bcontainer\\b',
  'class\\s*=\\s*["\'][^"\']*\\bblocked-icon\\b',
  '<p(?:\\s[^>]*)?>\\s*Unable to load site\\s*</p>',
  'href\\s*=\\s*["\']https://status\\.openai\\.com(?:/|["\'])',
];
export function isSiteUnavailableHtml(text) {
  return UNAVAILABLE_HTML_PATTERNS.every(pattern => new RegExp(pattern, 'i').test(text));
}
export function siteUnavailableError() {
  const error = new Error('ChatGPT показал «Unable to load site» вместо диалога. Сообщения недоступны; причина не установлена. Повторите выгрузку, когда сайт снова открывается обычным способом.');
  error.code = 'provider_site_unavailable'; error.stopQueue = true; return error;
}
