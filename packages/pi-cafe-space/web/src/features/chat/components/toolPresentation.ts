import { parseToolArgs, type ToolView } from '../runtime/convertMessages';
export interface DiffRow { kind: 'add' | 'remove' | 'context' | 'separator'; text: string; oldLine: number | null; newLine: number | null }
export interface ToolPreview { title: string; target: string; diff: DiffRow[] | null; source: 'result' | 'requested-edit' | null; added: number; removed: number; outputLines: number; outputPreview: string; outputTruncated: boolean }
const plain = (text: string, max: number) => [...text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ')].slice(0, max).join('');
function lines(text: string): string[] { if (!text) return []; const result = text.split('\n'); if (result.at(-1) === '') result.pop(); return result; }
/** Small input snippets only: O(n*m), bounded before allocation. */
export function editDiff(before: string, after: string): DiffRow[] | null {
  if (before.length + after.length > 12000) return null;
  const a = lines(before), b = lines(after);
  if (a.length > 200 || b.length > 200 || a.some(x => x.length > 2000) || b.some(x => x.length > 2000)) return null;
  const width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1]! : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0, j = 0; const rows: DiffRow[] = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: 'context', text: a[i]!, oldLine: i + 1, newLine: j + 1 }); i++; j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { rows.push({ kind: 'remove', text: a[i]!, oldLine: ++i, newLine: null }); }
    else { rows.push({ kind: 'add', text: b[j]!, oldLine: null, newLine: ++j }); }
  }
  return rows;
}
export function outputDiff(text: string): DiffRow[] | null {
  if (text.length > 16000) return null;
  const input = text.split('\n'); if (input.length > 400) return null;
  const begin = input.findIndex(line => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  if (begin < 0) return null;
  let old = 0, next = 0, remainingOld = 0, remainingNew = 0; const result: DiffRow[] = [];
  for (const line of input.slice(begin)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      if (remainingOld || remainingNew) return null;
      old = Number(match[1]); next = Number(match[3]); remainingOld = Number(match[2] ?? 1); remainingNew = Number(match[4] ?? 1);
      if (![old,next,remainingOld,remainingNew].every(Number.isSafeInteger) || remainingOld > 400 || remainingNew > 400) return null;
      result.push({ kind: 'separator', text: line, oldLine: null, newLine: null }); continue;
    }
    if (line.startsWith('\\ No newline')) continue;
    if (!line && !remainingOld && !remainingNew) continue;
    if (line[0] === '-' && remainingOld > 0) { result.push({ kind: 'remove', text: line.slice(1), oldLine: old++, newLine: null }); remainingOld--; }
    else if (line[0] === '+' && remainingNew > 0) { result.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: next++ }); remainingNew--; }
    else if (line[0] === ' ' && remainingOld > 0 && remainingNew > 0) { result.push({ kind: 'context', text: line.slice(1), oldLine: old++, newLine: next++ }); remainingOld--; remainingNew--; }
    else return null;
  }
  return remainingOld || remainingNew ? null : result;
}
export function toolPresentation(view: ToolView): ToolPreview {
  const args = view.argsValid ? parseToolArgs(view.argsText) : undefined;
  const field = (...names: string[]) => { for (const name of names) if (typeof args?.[name] === 'string') return args[name] as string; return ''; };
  const target = field('path','file_path','filePath','command','pattern','query');
  let diff = view.hasOutput && view.status === 'complete' ? outputDiff(view.output) : null;
  let source: ToolPreview['source'] = diff ? 'result' : null;
  if (!diff && /(?:^|[._-])edit$/i.test(view.name) && args) {
    const before = args.oldText ?? args.old_text, after = args.newText ?? args.new_text;
    if (typeof before === 'string' && typeof after === 'string') { diff = editDiff(before, after); if (diff) source = 'requested-edit'; }
  }
  const outputLines = view.output ? view.output.split('\n').length : 0;
  const preview = view.output.split('\n'); const chosen = view.status === 'running' ? preview.slice(-4) : preview.slice(0, 5);
  const joined = chosen.join('\n');
  return { title: plain(view.name, 80), target: plain(target, 160), diff, source, added: diff?.filter(row => row.kind === 'add').length ?? 0, removed: diff?.filter(row => row.kind === 'remove').length ?? 0, outputLines, outputPreview: joined.slice(0, 1600), outputTruncated: chosen.length < preview.length || joined.length > 1600 };
}
