import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
export const platforms = ['windows-amd64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
export function platformTag(platform = process.platform, arch = process.arch) {
  const value = { 'win32-x64': 'windows-amd64', 'linux-x64': 'linux-amd64', 'linux-arm64': 'linux-arm64', 'darwin-x64': 'darwin-amd64', 'darwin-arm64': 'darwin-arm64' }[`${platform}-${arch}`];
  if (!value) throw Error('Unsupported relay platform'); return value;
}
export function binaryMatches(bytes, platform) {
  if (bytes.length < 64) return false;
  if (platform === 'windows-amd64') { const offset = bytes.readUInt32LE(60); return bytes.toString('ascii', 0, 2) === 'MZ' && offset + 6 <= bytes.length && bytes.toString('hex', offset, offset + 4) === '50450000' && bytes.readUInt16LE(offset + 4) === 0x8664; }
  if (platform.startsWith('linux-')) return bytes.toString('hex', 0, 6) === '7f454c460201' && bytes.readUInt16LE(18) === (platform.endsWith('amd64') ? 62 : 183);
  if (platform.startsWith('darwin-')) return bytes.toString('hex', 0, 4) === 'cffaedfe' && bytes.readUInt32LE(4) === (platform.endsWith('amd64') ? 0x01000007 : 0x0100000c);
  return false;
}
export async function relayBinary(packageRoot, tag = platformTag()) {
  if (!platforms.includes(tag)) throw Error('Unsupported relay platform');
  const root = await realpath(packageRoot);
  let directory = root;
  for (const segment of ['dist', 'relay', 'bin', tag]) { directory = join(directory, segment); const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Untrusted relay directory'); }
  const metadataPath = join(root, 'dist/relay/build.json'); const metadataStat = await lstat(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 65536) throw Error('Invalid relay build metadata');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); const record = metadata.platforms?.[tag];
  if (!record || record.platform !== tag || record.webDigest !== metadata.webDigest || record.version !== metadata.version) throw Error('Missing matching platform binary; build explicitly from source');
  const binary = join(directory, tag.startsWith('windows') ? 'pi-cafe-relay.exe' : 'pi-cafe-relay'); const stat = await lstat(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw Error('Invalid relay executable');
  const bytes = await readFile(binary);
  if (!binaryMatches(bytes, tag) || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw Error('Relay executable checksum/platform mismatch');
  return binary;
}
