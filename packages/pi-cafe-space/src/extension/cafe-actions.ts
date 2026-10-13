import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qrPreviewHTML } from './cafe-render.js';
import { constants } from 'node:fs';

export function isRemoteTerminal(env: NodeJS.ProcessEnv = process.env): boolean { return !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT); }
export interface NativeAction { command: string; args: string[]; input?: string }
export function browserAction(url: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): NativeAction | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.pathname !== '/' || (u.hash && u.hash !== '#/rooms/main?panel=share')) throw Error('INVALID_LOCAL_URL');
  if (isRemoteTerminal(env)) return null;
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [u.href] };
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return { command: '/usr/bin/xdg-open', args: [u.href] };
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', u.href] };
  return null;
}
export async function createQrPreview(invitation: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const html = qrPreviewHTML(invitation);
  const directory = await mkdtemp(join(tmpdir(), 'pi-cafe-qr-'));
  const path = join(directory, 'room-qr.html');
  try { await writeFile(path, html, { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}
export function previewBrowserAction(path: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): NativeAction | null {
  if (isRemoteTerminal(env)) return null;
  const url = pathToFileURL(path).href;
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] };
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return { command: '/usr/bin/xdg-open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return null;
}
export async function clipboardAction(url: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<NativeAction | null> {
  if (url.length > 4096 || /[\u0000-\u0020\u007f]/.test(url)) throw Error('INVALID_INVITATION');
  const u = new URL(url); if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.search || !/^#\/room\/[A-Za-z0-9_-]{87}$/.test(u.hash)) throw Error('INVALID_INVITATION');
  if (isRemoteTerminal(env)) return null;
  if (platform === 'darwin') return { command: '/usr/bin/pbcopy', args: [], input: url };
  if (platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'], input: url };
  if (platform === 'linux') {
    for (const [enabled, command, args] of [[env.WAYLAND_DISPLAY, '/usr/bin/wl-copy', []], [env.DISPLAY, '/usr/bin/xclip', ['-selection', 'clipboard']]] as const) {
      if (!enabled) continue; try { await access(command, constants.X_OK); return { command, args: [...args], input: url }; } catch { /* No implicit helper install or terminal escape clipboard fallback. */ }
    }
  }
  return null;
}
export async function runNativeAction(action: NativeAction, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const env: NodeJS.ProcessEnv = {}; for (const name of ['HOME','PATH','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','LC_ALL','SystemRoot','WINDIR','TEMP','TMP']) if (process.env[name]) env[name] = process.env[name];
  return new Promise(resolve => {
    let complete = false; const finish = (ok: boolean) => { if (complete) return; complete = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(ok); };
    const child = spawn(action.command, action.args, { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const abort = () => { child.kill('SIGTERM'); finish(false); };
    const timer = setTimeout(abort, 5000); timer.unref();
    child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0)); child.stdin.on('error', () => finish(false));
    signal.addEventListener('abort', abort, { once: true }); child.stdin.end(action.input ?? '');
    if (signal.aborted) abort();
  });
}
