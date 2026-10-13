export const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
export interface DirectoryData { kind: 'directory'; path: string; truncated: boolean; entries: { name: string; kind: 'directory' | 'file' | 'link' }[] }
export interface FileData { kind: 'file'; path: string; offset: number; bytesRead: number; size: number; content: string; truncated: boolean }
export function parseDirectory(value: unknown): DirectoryData | null {
  const d = record(value);
  return d?.kind === 'directory' && text(d.path, 16384) && typeof d.truncated === 'boolean' && Array.isArray(d.entries) && d.entries.length <= 300 && d.entries.every(item => {
    const e = record(item); return e && text(e.name, 4096) && ['directory', 'file', 'link'].includes(String(e.kind));
  }) ? d as unknown as DirectoryData : null;
}
export function parseFile(value: unknown): FileData | null {
  const d = record(value);
  return d?.kind === 'file' && text(d.path, 16384) && integer(d.offset) && integer(d.bytesRead, 128 * 1024) && integer(d.size) && text(d.content, 128 * 1024) && typeof d.truncated === 'boolean' ? d as unknown as FileData : null;
}
export function childPath(parent: string, name: string): string | null {
  if (!name || name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f]/.test(name)) return null;
  const path = parent === '.' ? name : `${parent}/${name}`;
  return path.length <= 16384 ? path : null;
}
