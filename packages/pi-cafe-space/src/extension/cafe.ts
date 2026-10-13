import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { inspectCafe, localCafeURL, type CafeConfig, type CafeInfo } from './cafe-client.js';
import { CafeApprovalController } from './cafe-approvals.js';
import { CafePanel, type CafeAction, type CafeView } from './cafe-render.js';
import { browserAction, clipboardAction, createQrPreview, previewBrowserAction, isRemoteTerminal, runNativeAction } from './cafe-actions.js';

export interface CafeOwner { config(): CafeConfig; status(): string; connect(ctx: ExtensionContext): Promise<void>; disconnect(): void; modelsRefreshed?(ctx: ExtensionContext): void }
export async function claimOnboarding(config: CafeConfig): Promise<boolean> {
  if (!config.credentialsFile) return false;
  const dir = dirname(config.credentialsFile), base = localCafeURL(config.relayUrl); if (!base) return false;
  try {
    const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) return false;
    const name = 'cafe-welcome-v1-' + createHash('sha256').update(base).digest('hex').slice(0, 16) + '.json';
    const file = await open(join(dir, name), 'wx', 0o600);
    try { await file.writeFile('{"version":1,"shown":true}\n'); } finally { await file.close(); }
    return true;
  } catch { return false; }
}
const retained = globalThis as typeof globalThis & { __cafeHintShown?: boolean };
export function cafeView(info: CafeInfo, localStatus: string, sharing: boolean, notice = ''): CafeView {
  const joined = localStatus.startsWith('connected');
  const details: string[] = [];
  let subtitle = '', items: CafeView['items'] = [];
  if (info.state === 'ready' || info.state === 'room-offline') {
    subtitle = info.online ? '房间已登记在线 · 访客仍需输入密码' : '本机网关正常 · 房间暂时离线';
    details.push('房间：' + info.name, `本 Pi：${joined && info.currentPiInRoom ? '已加入房间' : joined ? '已连接网关，但不在这个房间' : '尚未加入房间'}`, `共享范围：同一房间中的 ${info.activeInstances} 个 Pi 实例`);
    if (sharing) {
      details.push('手机相机扫码，或在另一台设备打开链接。', '密码只由房主另行告知，不显示在这里。');
      items = [{ action: 'preview', label: '显示高清二维码，无需登录  [P]' }, { action: 'copy', label: '复制房间链接  [C]' }, { action: 'open', label: '在浏览器中管理分享  [B]' }, { action: 'refresh', label: '刷新房间状态  [R]' }, { action: 'back', label: '返回' }];
    } else {
      items = [{ action: 'share', label: '分享房间：二维码与链接' }, { action: 'approvals', label: '审批当前 Pi 的控制权申请  [A]' }, { action: 'open', label: '打开网页工作台与分享管理  [B]' }, { action: 'refresh', label: '检查连接  [R]' }, { action: joined ? 'disconnect' : 'connect', label: joined ? '仅将当前 Pi 移出房间' : '将当前 Pi 加入房间' }, { action: 'exit', label: '返回 Pi' }];
    }
    details.push('审批关闭时访客可直接操作；开启后须由房主批准。');
    if (!info.online) details.push('链接可以复制，但当前不能保证手机能够连接；请稍后刷新。');
  } else {
    const copy: Record<CafeInfo['state'], [string, string]> = {
      setup: ['首次使用：完成网页设置', '在本机网页设置自己的令牌后，回来按 R 刷新。不会自动生成密码。'],
      'local-only': ['本 Pi 可连接本机，但尚未开启房间访问', '在工作台检查房间配置；仅本机连接成功不等于手机可访问。'],
      'gateway-offline': ['本机网关未接受连接', '本地 Pi 仍可继续使用。请检查网关是否已启动，或按 R 重试。'],
      'gateway-timeout': ['读取本机网关超时', '查询已停止；这不代表房间或密码失效。请按 R 重试，无需重置房间。'],
      'gateway-error': ['本机网关响应异常', '未取得有效的房间信息，这不等于网关未启动。请按 R 重试或检查本机版本；不要重置密码。'],
      'update-needed': ['本机网关尚不支持终端分享', '请在网页使用分享功能，或升级到包含 /cafe 的网关版本。'],
      'auth-error': ['本机连接凭据需要检查', '不要重置房间或把密码贴到终端；先检查网关和本机凭据配置是否一致。'],
      'not-local': ['当前 Pi 连接的不是本机网关', '不要把远端 localhost 当成本机地址。请在网关所在电脑打开分享，或使用安全端口转发。'],
      ready: ['', ''], 'room-offline': ['', ''],
    };
    [subtitle] = copy[info.state]; details.push(copy[info.state][1]);
    if (info.localURL) items.push({ action: 'open', label: info.state === 'setup' ? '打开首次设置网页  [B]' : '打开本机工作台  [B]' });
    items.push({ action: 'refresh', label: '重新检查  [R]' }, { action: joined ? 'disconnect' : 'connect', label: joined ? '仅将当前 Pi 移出房间' : '尝试连接当前 Pi' }, { action: 'exit', label: '返回 Pi' });
  }
  return { title: sharing && info.url ? 'Café Space · 分享房间' : 'Café Space', subtitle, details, items, sharing: sharing && !!info.url, ...(notice ? { notice } : {}), ...(sharing && info.url ? { invitation: info.url } : {}) };
}
export class CafeController {
  #controller = new AbortController(); #opened = false; #generation = 0;
  #preview: { url: string; file: Awaited<ReturnType<typeof createQrPreview>>; timer: ReturnType<typeof setTimeout> } | null = null;
  #clearPreview(): void { const old = this.#preview; this.#preview = null; if (old) { clearTimeout(old.timer); void old.file.dispose().catch(() => {}); } }
  #approvals: CafeApprovalController;
  constructor(private readonly owner: CafeOwner, private readonly api?: Pick<ExtensionAPI,'setModel'|'getThinkingLevel'|'setThinkingLevel'>) { this.#approvals = new CafeApprovalController(() => this.owner.config()); }
  onStart(ctx: ExtensionContext): void {
    if (this.#controller.signal.aborted) this.#controller = new AbortController();
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    this.#approvals.start(ctx);
    const generation = this.#generation;
    void (async () => {
      const config = this.owner.config(); const first = await claimOnboarding(config);
      if (this.#controller.signal.aborted || generation !== this.#generation) return;
      if (first || !retained.__cafeHintShown) {
        retained.__cafeHintShown = true;
        ctx.ui.notify(first ? 'Café Space\n在手机、笔记本上查看和继续使用 Pi。\n输入 /cafe 打开房间面板，复制链接或显示二维码。\n你也可以继续在这里使用 Pi。' : 'Café Space · 输入 /cafe 分享房间、扫码或检查连接。', 'info');
      }
    })().catch(() => { /* Onboarding is optional and must not block Pi. */ });
  }
  stop(): void { this.#approvals.stop(); this.#generation++; this.#controller.abort(); this.#clearPreview(); }
  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== 'tui' || !ctx.hasUI) { if (ctx.hasUI) ctx.ui.notify('请在交互式 Pi 终端使用 /cafe；RPC 不展示房间邀请或二维码。', 'info'); return; }
    if (this.#opened) { ctx.ui.notify('Café Space 面板已打开，Esc 可返回。', 'info'); return; }
    const verb = args.trim(); if (!['', 'share', 'qr', 'open', 'status', 'help', 'connect', 'disconnect', 'approvals', 'models'].includes(verb)) { ctx.ui.notify('用法：/cafe · /cafe share · /cafe qr · /cafe open · /cafe status · /cafe approvals · /cafe models（重新读取模型配置）。不要在命令后填写密码。', 'warning'); return; }
    if (this.#controller.signal.aborted) this.#controller = new AbortController();
    this.#opened = true; const generation = this.#generation, signal = this.#controller.signal;
    let sharing = verb === 'share' || verb === 'qr', notice = '', first = true;
    try {
      if (verb === 'models') {
        if (!this.api || !ctx.isIdle()) { ctx.ui.notify('Café Space · 请等待当前任务结束后再重新加载模型配置。','warning'); return; }
        const current=ctx.model,sessionId=ctx.sessionManager.getSessionId(),cwd=ctx.cwd,level=this.api.getThinkingLevel();
        if(!current){ctx.ui.notify('Café Space · 当前未选择模型。','warning');return;}
        const registry=ctx.modelRegistry as typeof ctx.modelRegistry & {refresh:(options?:{allowNetwork?:boolean})=>Promise<unknown>};
        await registry.refresh({allowNetwork:false});
        if(!ctx.isIdle()||ctx.sessionManager.getSessionId()!==sessionId||ctx.cwd!==cwd||ctx.model?.provider!==current.provider||ctx.model?.id!==current.id){ctx.ui.notify('Café Space · 会话或模型已变化，没有替换当前模型。','warning');return;}
        const updated=ctx.modelRegistry.find(current.provider,current.id);
        if(!updated||!await this.api.setModel(updated)){ctx.ui.notify('Café Space · 未能重新加载当前模型，请检查本机模型配置。','warning');return;}
        this.api.setThinkingLevel(level);
        this.owner.modelsRefreshed?.(ctx);
        ctx.ui.notify(`Café Space · 已重新读取 ${updated.id} 的模型配置；当前思考等级 ${this.api.getThinkingLevel()}。`,'info');return;
      }
      if (verb === 'approvals') { await this.#approvals.open(ctx); return; }
      if (verb === 'connect') await this.owner.connect(ctx);
      if (verb === 'disconnect') { const yes = await ctx.ui.confirm('仅移出当前 Pi', '当前 Pi 将不再向房间提供会话，其他 Pi 和正在本地执行的任务不受影响。', { signal }); if (yes && !signal.aborted) this.owner.disconnect(); }
      for (;;) {
        if (signal.aborted || generation !== this.#generation) return;
        const config = this.owner.config();
        const info = await inspectCafe(config, sharing, signal);
        if (signal.aborted || generation !== this.#generation) return;
        let action: CafeAction;
        if (first && verb === 'open') action = 'open';
        else if (first && verb === 'qr' && info.url) action = 'preview';
        else {
          const view = cafeView(info, this.owner.status(), sharing, notice); notice = '';
          action = await ctx.ui.custom<CafeAction>((tui, theme, _keys, done) => {
            const panel = new CafePanel(view, () => tui.terminal.rows, { title: s => theme.fg('accent', s), muted: s => theme.fg('muted', s), selected: s => theme.fg('accent', s) }, () => tui.requestRender(), done);
            const abort = () => done('exit'); signal.addEventListener('abort', abort, { once: true });
            return { render: width => panel.render(width), handleInput: data => panel.handleInput(data), invalidate: () => panel.invalidate(), dispose: () => { signal.removeEventListener('abort', abort); panel.dispose(); } };
          });
        }
        first = false;
        if (signal.aborted || generation !== this.#generation || action === 'exit') return;
        if (action === 'back') { sharing = false; continue; }
        if (action === 'share') { sharing = true; continue; }
        if (action === 'approvals') { await this.#approvals.open(ctx); continue; }
        if (action === 'refresh') continue;
        if (action === 'copy' && info.url) {
          const current = await inspectCafe(config, true, signal);
          if (current.url !== info.url) { notice = '房间链接已变化，请核对刷新后的链接，再复制。'; continue; }
          const request = await clipboardAction(info.url);
          const ok = request && await runNativeAction(request, signal);
          notice = ok ? '房间链接已复制；二维码和链接都不包含密码。' : isRemoteTerminal() ? 'SSH终端不能可靠写入你手边设备的剪贴板。请选中上方链接复制，或用手机扫码。' : '无法使用剪贴板，请选中上方链接手动复制。';
        } else if (action === 'preview' && info.url) {
          if (isRemoteTerminal()) { notice = 'SSH终端不会打开远端浏览器。请复制链接到手边电脑，或放大终端使用 S 实心二维码。'; continue; }
          if (this.#preview?.url !== info.url) {
            this.#clearPreview(); const file = await createQrPreview(info.url);
            if (signal.aborted || generation !== this.#generation) { await file.dispose(); return; }
            const timer = setTimeout(() => this.#clearPreview(), 15 * 60 * 1000); timer.unref();
            this.#preview = { url: info.url, file, timer };
          }
          const request = previewBrowserAction(this.#preview.file.path);
          const ok = request && await runNativeAction(request, signal);
          notice = ok ? '已请求打开本地高清二维码，无需登录。它与复制链接指向同一房间，不包含密码。' : '无法打开本机浏览器，请使用 C 复制链接或 S 实心终端二维码。';
        } else if (action === 'open') {
          const target = info.state === 'setup' ? info.localURL ? info.localURL + '/' : null : info.sharePage;
          const request = target ? browserAction(target) : null;
          const ok = request && await runNativeAction(request, signal);
          notice = ok ? '已请求浏览器打开。需要登录时，登录后会回到分享面板。' : isRemoteTerminal() ? '这是SSH终端，不会打开远端浏览器。请直接在终端分享，或用受控端口转发访问管理页。' : '无法打开浏览器。请手动访问：' + (target ?? '网关所在电脑的工作台');
        } else if (action === 'connect') { await this.owner.connect(ctx); notice = '已请求连接当前 Pi，状态以实际握手结果为准。'; }
        else if (action === 'disconnect') {
          const yes = await ctx.ui.confirm('仅移出当前 Pi', '当前 Pi 的会话将退出房间展示，其他实例和本地任务不受影响。', { signal });
          if (yes && !signal.aborted) { this.owner.disconnect(); notice = '当前 Pi 已移出；其他实例仍由网关管理。'; }
        }
      }
    } catch { if (!signal.aborted && generation === this.#generation) { try { ctx.ui.notify('Café Space 暂时无法完成操作。没有修改密码或重置房间，请稍后重试 /cafe。', 'warning'); } catch {} } }
    finally { this.#opened = false; }
  }
}
export function registerCafe(pi: ExtensionAPI, owner: CafeOwner): CafeController {
  const controller = new CafeController(owner, pi);
  pi.registerCommand('cafe', { description: 'Café Space：分享房间、控制权审批、二维码和连接状态', getArgumentCompletions: prefix => ['share','qr','open','status','help','connect','disconnect','approvals','models'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })), handler: (args, ctx) => controller.command(args, ctx) });
  return controller;
}
