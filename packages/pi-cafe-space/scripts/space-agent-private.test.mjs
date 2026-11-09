import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const windows = process.platform === 'win32';
const client = fileURLToPath(new URL('./space-agent.mjs', import.meta.url));
const token = 'synthetic-private-member-token';
const run = (home, args, input = '', flags = []) => new Promise(resolve => {
  const child = execFile(process.execPath, [...flags, client, '--home', home, ...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
    assert(!stdout.includes(token) && !stderr.includes(token), 'credential leaked');
    resolve({ code: error?.code ?? 0, out: stdout.trim(), err: stderr.trim() });
  });
  child.stdin.on('error', () => {}); child.stdin.end(input);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'space-private-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function acl(path, code) {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.Encoding]::UTF8;$p=[Console]::In.ReadToEnd();$a=(Get-Item -LiteralPath $p -Force).GetAccessControl();${code}`;
  return execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: path, encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function assertPrivate(path, directory = false) {
  const value = JSON.parse(acl(path, `@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;rights=[int]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags}})}|ConvertTo-Json -Depth 4`));
  assert.equal(value.owner, value.user);
  if (directory) assert.equal(value.protected, true);
  const grants = value.rules.filter(r => r.type === 'Allow');
  assert(grants.every(r => [value.user, 'S-1-5-18'].includes(r.sid)));
  assert(grants.some(r => r.sid === value.user && r.rights === 2032127 && (!directory || r.inheritance === 3)));
}
async function home(t, name = 'home') {
  const path = join(fixture(t), name);
  const result = await run(path, ['status']);
  assert.equal(result.code, 1); assert.match(result.err, /not joined/);
  return path;
}
function member(path) {
  writeFileSync(join(path, 'member.json'), JSON.stringify({ origin: 'http://127.0.0.1', roomId: 'room', memberId: 'me', token }));
}
const publicRead = `$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')));(Get-Item -LiteralPath $p).SetAccessControl($a)`;

test('Windows creates an owner-only inheritable home; Unicode and PowerShell characters are literal', { skip: !windows }, async t => {
  const path = await home(t, "nested/private ' $() [room] 中文");
  assertPrivate(path, true); member(path); assertPrivate(join(path, 'member.json'));
  const result = await run(path, ['status']); assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).memberId, 'me');
  for (const invalid of ['relative', 'C:relative', '\\rooted', '\\\\localhost\\share\\home']) {
    assert.match((await run(invalid, ['status'])).err, /absolute local-drive/);
  }
});

test('Windows refuses public or non-inheritable homes without changing their ACL', { skip: !windows }, async t => {
  const inherited = fixture(t);
  assert.match((await run(inherited, ['status'])).err, /private Windows ACL/);
  const path = await home(t); acl(path, publicRead);
  const before = acl(path, '$a.Sddl');
  assert.match((await run(path, ['status'])).err, /private Windows ACL/);
  assert.equal(acl(path, '$a.Sddl'), before, 'an existing ACL must not be silently repaired');
  assert.deepEqual(readdirSync(path), []);
  const noInheritance = await home(t, 'no-inheritance');
  acl(noInheritance, `$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($u);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'FullControl','Allow')));(Get-Item -LiteralPath $p).SetAccessControl($a)`);
  assert.match((await run(noInheritance, ['status'])).err, /private Windows ACL/);
});

test('Windows refuses a public credential or state file even inside a private home', { skip: !windows }, async t => {
  for (const name of ['member.json', 'state.json']) {
    const path = await home(t, name); member(path);
    writeFileSync(join(path, 'state.json'), JSON.stringify({ fetched: 7, consumed: 2, skipped: [] }));
    acl(join(path, name), publicRead);
    const before = readFileSync(join(path, name), 'utf8');
    const result = await run(path, ['status']); assert.equal(result.code, 1); assert.match(result.err, /private Windows ACL/);
    assert.equal(readFileSync(join(path, name), 'utf8'), before);
  }
});

test('Windows rejects home/ancestor junctions and non-regular credential files', { skip: !windows }, async t => {
  const root = fixture(t), target = await home(t), link = join(root, 'link');
  symlinkSync(target, link, 'junction');
  for (const path of [link, join(link, 'child')]) assert.match((await run(path, ['status'])).err, /reparse points/);
  assert.deepEqual(readdirSync(target), [], 'no write through a junction');
  symlinkSync(target, join(target, 'member.json'), 'junction');
  assert.match((await run(target, ['status'])).err, /private regular file/);
});

test('Windows join, inbox sync and ordered confirmation persist privately across processes', { skip: !windows }, async t => {
  const root = fixture(t), path = join(root, 'home'), acks = [];
  const message = { seq: 1, id: 'message-1', memberId: 'peer', text: 'synthetic message', at: '2026-01-01T00:00:00Z' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const q = JSON.parse(body); res.setHeader('Content-Type', 'application/json');
    if (q.op === 'join') { res.end(JSON.stringify({ roomId: 'a'.repeat(32), memberId: 'me', token })); return; }
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    if (q.op === 'ack') { acks.push(q); res.end('{}'); return; }
    assert.equal(q.op, 'read');
    res.end(JSON.stringify(q.latest ? { latestSeq: 0, messages: [] } : { cursor: 1, messages: q.after < 1 ? [message] : [], more: false, aiPaused: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const invite = `http://127.0.0.1:${server.address().port}/#/collab/${'a'.repeat(32)}?invite=${'b'.repeat(64)}`;
  let result = await run(path, ['join', '--name', 'ACL test'], invite); assert.equal(result.code, 0, result.err);
  result = await run(path, ['sync']); assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).fetched, 1);
  assert.equal(JSON.parse((await run(path, ['next'])).out).seq, 1);
  assert.equal((await run(path, ['done', '2'])).code, 1, 'no out-of-order consumption');
  result = await run(path, ['done', '1']); assert.equal(result.code, 0, result.err);
  assert.equal((await run(path, ['next'])).out, '', 'no replay after confirmation');
  assert.equal((await run(path, ['sync'])).code, 0);
  assert.equal(acks.at(-1).delivered, 1);
  assert.equal(readFileSync(join(path, 'inbox.jsonl'), 'utf8').trim().split('\n').length, 1);
  assertPrivate(path, true);
  assert.deepEqual(readdirSync(path).sort(), ['inbox.jsonl', 'member.json', 'state.json']);
  for (const name of readdirSync(path)) assertPrivate(join(path, name));
});

test('Windows failed flush or rename keeps the old cursor and any temporary file private', { skip: !windows }, async t => {
  for (const operation of ['fsyncSync', 'renameSync']) {
    const path = await home(t, operation); member(path);
    const state = JSON.stringify({ fetched: 1, consumed: 0, skipped: [] });
    writeFileSync(join(path, 'state.json'), state);
    writeFileSync(join(path, 'inbox.jsonl'), JSON.stringify({ seq: 1, memberId: 'peer', text: 'pending' }) + '\n');
    const preload = join(path, 'fail-write.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';fs.${operation}=()=>{throw Error('synthetic write failure')};syncBuiltinESMExports();`);
    const result = await run(path, ['done', '1'], '', ['--import', pathToFileURL(preload).href]);
    assert.equal(result.code, 1); assert.match(result.err, /synthetic write failure/);
    assert.equal(readFileSync(join(path, 'state.json'), 'utf8'), state);
    const temporary = readdirSync(path).filter(name => name.endsWith('.tmp')); assert.equal(temporary.length, 1);
    assertPrivate(join(path, temporary[0]));
  }
});

test('Windows ACL helper failure is fail-closed before credential reads', { skip: !windows }, async t => {
  const path = await home(t); member(path);
  const preload = join(path, 'fail-acl.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.execFileSync=()=>{throw Error('synthetic ACL failure')};syncBuiltinESMExports();`);
  const result = await run(path, ['status'], '', ['--import', pathToFileURL(preload).href]);
  assert.equal(result.code, 1); assert.equal(result.out, ''); assert.match(result.err, /private Windows ACL/);
});
