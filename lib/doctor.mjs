import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

export async function doctor() {
  const paths = process.platform === 'darwin' ? {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    msedge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  } : process.platform === 'win32' ? {
    chrome: (process.env.PROGRAMFILES || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe',
    msedge: (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') + '\\Microsoft\\Edge\\Application\\msedge.exe',
  } : { chrome: '/opt/google/chrome/chrome', msedge: '/opt/microsoft/msedge/msedge' };
  paths.chromium = chromium.executablePath();
  const browsers = {};
  for (const [name, path] of Object.entries(paths)) {
    try { await access(path); browsers[name] = { found: true, path }; }
    catch { browsers[name] = { found: false, path }; }
  }
  return { node: process.version, platform: process.platform, arch: process.arch, node_ok: Number(process.versions.node.split('.')[0]) >= 22,
    browsers, suggested_browser: Object.keys(browsers).find(name => browsers[name].found) || null,
    chromium_install: 'npx playwright install chromium', requires_local_desktop: true,
    live_corporate_export_verified: false, default_connection: 'existing',
    extraction_method: 'rendered-ui-v1', native_export_required: false,
    existing_session_access: { chrome_144_plus: 'chrome://inspect/#remote-debugging', macos_native: process.platform === 'darwin',
      automatic_login_copy: false, permission_may_be_required: true },
    transport: 'local stdio or local CLI worker; no HTTP listener' };
}
