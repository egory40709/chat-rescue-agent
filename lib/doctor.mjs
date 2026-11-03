import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { TOOL_VERSION } from './version.mjs';

export function browserCandidates({ platform = process.platform, env = process.env, home = homedir(), chromiumPath = chromium.executablePath() } = {}) {
  let paths;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    const machine = env.PROGRAMFILES || 'C:\\Program Files';
    const x86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    paths = {
      chrome: [win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), win32.join(machine, 'Google', 'Chrome', 'Application', 'chrome.exe'), win32.join(x86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      msedge: [win32.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), win32.join(machine, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), win32.join(x86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    };
  } else if (platform === 'darwin') paths = {
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  };
  else paths = { chrome: ['/opt/google/chrome/chrome'], msedge: ['/opt/microsoft/msedge/msedge'] };
  paths.chromium = [chromiumPath];
  return paths;
}
export async function doctor() {
  const browsers = {};
  for (const [name, candidates] of Object.entries(browserCandidates())) {
    let found = null;
    for (const path of candidates) { try { await access(path); found = path; break; } catch { /* Try both user and machine installations. */ } }
    browsers[name] = { found: !!found, path: found || candidates[0], candidates };
  }
  return { tool_version: TOOL_VERSION, node: process.version, platform: process.platform, arch: process.arch, node_ok: Number(process.versions.node.split('.')[0]) >= 22,
    browsers, suggested_browser: Object.keys(browsers).find(name => browsers[name].found) || null,
    chromium_install: 'npx playwright install chromium', requires_local_desktop: true,
    live_corporate_export_verified: false, default_connection: 'existing',
    extraction_method: 'ui-conversation-v2', native_export_required: false,
    existing_session_access: { chrome_144_plus: 'chrome://inspect/#remote-debugging', macos_native: process.platform === 'darwin',
      automatic_login_copy: false, permission_may_be_required: true },
    transport: 'local stdio or local CLI worker; no HTTP listener' };
}
