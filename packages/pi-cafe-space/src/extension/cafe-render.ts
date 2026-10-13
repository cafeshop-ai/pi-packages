import qrcode from 'qrcode-generator';
import { matchesKey, isKeyRelease, wrapTextWithAnsi, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export type CafeAction = 'share' | 'copy' | 'open' | 'preview' | 'refresh' | 'connect' | 'disconnect' | 'back' | 'exit' | 'help' | 'approvals';
export interface CafeView {
  title: string; subtitle: string; details: string[]; notice?: string; invitation?: string;
  items: { action: CafeAction; label: string }[]; sharing?: boolean;
}
export interface RenderStyle { title(text: string): string; muted(text: string): string; selected(text: string): string }
export function qrMatrix(url: string): boolean[][] {
  if (!url || url.length > 4096 || !/^[\x21-\x7e]+$/.test(url)) throw Error('INVALID_QR_URL');
  const qr = qrcode(0, 'M'); qr.addData(url, 'Byte'); qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count + 8 }, (_, r) => Array.from({ length: count + 8 }, (_, c) => r >= 4 && c >= 4 && r < count + 4 && c < count + 4 && qr.isDark(r - 4, c - 4)));
}
export function qrLines(matrix: boolean[][], solid = false): string[] {
  const result: string[] = [];
  const background = (dark: boolean) => dark ? '\x1b[48;2;0;0;0m' : '\x1b[48;2;255;255;255m';
  const foreground = (dark: boolean) => dark ? '\x1b[38;2;0;0;0m' : '\x1b[38;2;255;255;255m';
  for (let row = 0; row < matrix.length; row += solid ? 1 : 2) {
    let text = '\x1b[0m'; let previous = '';
    for (let col = 0; col < matrix.length; col++) {
      const top = !!matrix[row]?.[col], bottom = !!matrix[row + 1]?.[col];
      // A block glyph does not necessarily cover a terminal's whole cell.
      // Background fills line leading too. Never draw a full black cell as █.
      const style = background(top) + foreground(solid ? top : bottom);
      if (style !== previous) { text += style; previous = style; }
      text += solid ? '  ' : top === bottom ? ' ' : '▄';
    }
    result.push(text + '\x1b[0m');
  }
  return result;
}
export function qrPreviewHTML(invitation: string): string {
  const u = new URL(invitation);
  if (!(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)) || u.username || u.password || u.pathname !== '/' || u.search || !/^#\/room\/[A-Za-z0-9_-]{87}$/.test(u.hash)) throw Error('INVALID_INVITATION');
  const matrix = qrMatrix(invitation), n = matrix.length; let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n;) {
    if (!matrix[y]![x]) { x++; continue; } const start = x; while (x < n && matrix[y]![x]) x++;
    path += `M${start} ${y}h${x-start}v1H${start}z`;
  }
  const safe = invitation.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Café Space · 房间二维码</title><style>html{color-scheme:light}body{margin:0;padding:28px 20px;background:#f7f5f1;color:#28231e;font:16px/1.6 system-ui,sans-serif;text-align:center}main{max-width:760px;margin:auto}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0 20px}.code{display:block;background:white;width:min(82vw,62vh,636px);height:auto;aspect-ratio:1;margin:16px auto;box-shadow:0 0 0 1px #e3ded7}a{color:#624626;overflow-wrap:anywhere}small{display:block;color:#665f56;margin-top:18px}</style></head><body><main><h1>Café Space · 分享房间</h1><p>用手机相机扫码，再输入房间密码</p><svg class="code" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" aria-label="房间二维码" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg><p><a href="${safe}" rel="noreferrer">${safe}</a></p><small>二维码只包含房间链接，不包含密码。<br>这是本机生成的静态预览，不会向第三方二维码服务发送链接。</small></main></body></html>`;
}
export class CafePanel {
  #selected = 0; #qrOnly = false; #solid = process.env.TERM_PROGRAM === 'Apple_Terminal'; #closed = false; #matrix: boolean[][] | null;
  constructor(private readonly view: CafeView, private readonly rows: () => number, private readonly style: RenderStyle, private readonly redraw: () => void, private readonly done: (action: CafeAction) => void) {
    try { this.#matrix = view.invitation ? qrMatrix(view.invitation) : null; } catch { this.#matrix = null; }
  }
  invalidate(): void {}
  dispose(): void { this.#closed = true; this.#matrix = null; }
  handleInput(data: string): void {
    if (this.#closed || isKeyRelease(data)) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { if (this.#qrOnly) { this.#qrOnly = false; this.redraw(); } else this.finish(this.view.sharing ? 'back' : 'exit'); return; }
    if (data.toLowerCase() === 's' && this.#matrix) { this.#solid = !this.#solid; this.#qrOnly = true; this.redraw(); return; }
    if (data.toLowerCase() === 'q' && this.#matrix) { this.#qrOnly = !this.#qrOnly; this.redraw(); return; }
    if (matchesKey(data, 'up') || data === 'k') this.#selected = (this.#selected + this.view.items.length - 1) % this.view.items.length;
    else if (matchesKey(data, 'down') || data === 'j' || matchesKey(data, 'tab')) this.#selected = (this.#selected + 1) % this.view.items.length;
    else if (matchesKey(data, 'enter')) { const item = this.view.items[this.#selected]; if (item) this.finish(item.action); return; }
    else { const action = data.toLowerCase() === 'a' ? 'approvals' : data.toLowerCase() === 'p' ? 'preview' : data.toLowerCase() === 'c' ? 'copy' : data.toLowerCase() === 'b' ? 'open' : data.toLowerCase() === 'r' ? 'refresh' : null; if (action && this.view.items.some(i => i.action === action)) this.finish(action); return; }
    this.redraw();
  }
  private finish(action: CafeAction): void { if (!this.#closed) { this.#closed = true; this.done(action); } }
  render(width: number): string[] {
    const w = Math.max(8, Math.floor(width)), available = Math.max(8, Math.floor(this.rows()) - 2), inner = Math.max(6, w - 4);
    const line = (s: string) => '  ' + truncateToWidth(s, inner);
    const wrapped = (s: string) => wrapTextWithAnsi(s, inner).map(line);
    const header = [line(this.style.title(this.view.title)), ...wrapped(this.style.muted(this.view.subtitle)), ''];
    const footer = [line(this.style.muted('↑↓ 选择 · Enter 确认 · Esc 返回' + (this.#matrix ? ' · Q 二维码' : '')))];
    const qr = this.#matrix ? qrLines(this.#matrix, this.#solid) : [];
    const qrWidth = (this.#matrix?.length ?? 0) * (this.#solid ? 2 : 1);
    if (this.#qrOnly) {
      if (qr.length + 3 <= available && qrWidth <= inner) return [line(this.style.title(this.#solid ? '实心二维码 · 手机扫码，再输入密码' : '手机相机扫码，再输入房间密码')), ...qr.map(s => '  ' + s), line(this.style.muted('Esc 返回 · P 高清码 · C 复制 · S ' + (this.#solid ? '紧凑模式' : '实心模式')))];
      return [line(this.style.title('终端空间不足，二维码未被截断')), ...wrapped(`此模式需要至少 ${qrWidth + 4} 列 × ${qr.length + 5} 行。按 P 直接打开高清二维码，无需登录；C 复制链接。${this.#solid ? '按 S 返回紧凑模式。' : ''}`), ...footer].slice(0, available);
    }
    const details = this.view.details.flatMap(wrapped);
    const notice = this.view.notice ? [...wrapped(this.view.notice), ''] : [];
    const url = this.view.invitation ? [line(this.style.muted('房间链接（不含密码）')), ...wrapped(this.view.invitation), ''] : [];
    const items = this.view.items.map((item, index) => line(index === this.#selected ? this.style.selected('› ' + item.label) : '  ' + item.label));
    const lower = [...url, ...items, '', ...footer];
    const fixed = header.length + details.length + notice.length + lower.length;
    const canQR = qr.length > 0 && qr.length + fixed + 1 <= available && qrWidth <= inner;
    let middle = [...details, '', ...notice, ...(canQR ? [...qr.map(s => '  ' + s), ''] : this.#matrix ? [line(this.style.muted('Q 终端二维码 · P 高清二维码（无需登录）')), ''] : [])];
    // Never crop a QR or the selected action. Dense terminals sacrifice descriptive text first.
    const budget = Math.max(0, available - header.length - lower.length);
    if (middle.length > budget) middle = middle.slice(0, budget);
    const result = [...header, ...middle, ...lower];
    if (result.length > available) return [...header.slice(0, 2), ...items, ...footer].slice(0, available);
    return result;
  }
}
export { visibleWidth, wrapTextWithAnsi };
