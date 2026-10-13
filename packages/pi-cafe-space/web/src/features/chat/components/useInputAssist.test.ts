import { expect, it } from 'vitest';
import { completionAt, completedText, referencedFiles } from './useInputAssist';
it('recognizes only slash commands at the start and whitespace-bound file references, preserving cursor suffixes and spaces', () => {
  expect(completionAt('mail a@b.com', 12)).toBeNull();
  expect(completionAt('prose /name', 11)).toBeNull();
  const command = completionAt('/review extra', 4)!;
  expect(completedText('/review extra', command, { value: 'review:2', label: '', description: '' }).text).toBe('/review:2  extra');
  const file = completionAt('check @"src/咖啡 n" now', 16)!;
  expect(file.directory).toBe('src');
  expect(completedText('check @"src/咖啡 n" now', file, { value: 'src/咖啡 note.ts', label: '', description: '' }).text).toBe('check @"src/咖啡 note.ts"  now');
  expect(referencedFiles('a@b.com @src/a.ts @"src/咖啡 note.ts" @src/a.ts \\@literal')).toEqual(['src/a.ts', 'src/咖啡 note.ts']);
  expect(referencedFiles('unfinished @"space name')).toEqual([]);
  const directory = completedText('@', completionAt('@', 1)!, { value: 'my dir', label: '', description: '', directory: true });
  expect(directory.text).toBe('@"my dir/');
  expect(completionAt(directory.text, directory.cursor)?.directory).toBe('my dir');
});
