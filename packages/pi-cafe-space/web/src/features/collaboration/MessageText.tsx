import { Fragment, type ReactNode } from 'react';

// A deliberately small Markdown subset for room messages: paragraphs, lists,
// quotes, fenced code, inline code, bold and http(s) links. Everything becomes
// React elements; raw HTML is shown as text and no images or scripts load.
export function safeLink(value: string): string {
  if (!/^https?:\/\//i.test(value) || /[\u0000- \u007f]/.test(value)) return '';
  try { const url = new URL(value); return url.username || url.password ? '' : url.href; } catch { return ''; }
}
const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]，。；：！？）】]/g;
function links(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    const href = safeLink(match[2] ?? match[0]); const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    out.push(href ? <a key={key + index} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{match[1] ?? match[0]}</a> : match[0]);
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function inline(text: string, key: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).flatMap((part, i): ReactNode[] => {
    if (/^`[^`\n]+`$/.test(part)) return [<code key={key + 'c' + i}>{part.slice(1, -1)}</code>];
    if (/^\*\*[^*\n]+\*\*$/.test(part)) return [<strong key={key + 's' + i}>{links(part.slice(2, -2), key + 's' + i)}</strong>];
    return links(part, key + 't' + i);
  });
}
const bullet = /^\s*[-*+]\s+/, numbered = /^\s*\d+[.)]\s+/, quote = /^\s*>\s?/, heading = /^#{1,6}\s+/, fence = /^\s*```/;
const special = (line: string) => bullet.test(line) || numbered.test(line) || quote.test(line) || heading.test(line) || fence.test(line);
export function MessageText({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n'); const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!; const key = 'b' + i;
    if (fence.test(line)) {
      const body: string[] = []; i++;
      while (i < lines.length && !fence.test(lines[i]!)) body.push(lines[i++]!);
      i++; blocks.push(<pre key={key}><code>{body.join('\n')}</code></pre>); continue;
    }
    if (bullet.test(line) || numbered.test(line)) {
      const pattern = bullet.test(line) ? bullet : numbered; const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(lines[i++]!.replace(pattern, ''));
      const List = pattern === bullet ? 'ul' : 'ol';
      blocks.push(<List key={key}>{items.map((item, j) => <li key={j}>{inline(item, key + j)}</li>)}</List>); continue;
    }
    if (quote.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && quote.test(lines[i]!)) quoted.push(lines[i++]!.replace(quote, ''));
      blocks.push(<blockquote key={key}>{quoted.map((q, j) => <Fragment key={j}>{j > 0 && <br />}{inline(q, key + j)}</Fragment>)}</blockquote>); continue;
    }
    if (heading.test(line)) { blocks.push(<p key={key}><strong>{inline(line.replace(heading, ''), key)}</strong></p>); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !special(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push(<p key={key}>{paragraph.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, key + j)}</Fragment>)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}
