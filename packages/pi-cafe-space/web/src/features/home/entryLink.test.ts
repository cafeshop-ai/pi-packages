import { expect, it } from 'vitest';
import { classifyEntryLink } from './entryLink';

const origin = 'https://space.example';
const key = 'B' + 'A'.repeat(86);
const room = 'a'.repeat(32), invite = 'd'.repeat(64);

it('routes device room links and bare room keys to the device flow', () => {
  expect(classifyEntryLink(key, origin)).toEqual({ kind: 'device', path: '/room/' + key });
  expect(classifyEntryLink(`  ${origin}/#/room/${key}  `, origin)).toEqual({ kind: 'device', path: '/room/' + key });
});

it('routes collaboration links to the collaboration page and preserves the invite exactly', () => {
  expect(classifyEntryLink(`${origin}/#/collab/${room}?invite=${invite}`, origin)).toEqual({ kind: 'collab', path: `/collab/${room}?invite=${invite}` });
  expect(classifyEntryLink(`${origin}/#/collab/${room}`, origin)).toEqual({ kind: 'collab', path: `/collab/${room}` });
});

it('never turns a collaboration invite into a device route', () => {
  for (const value of [`${origin}/#/collab/${room}?invite=${invite}`, `${origin}/#/collab/${room}`]) expect(classifyEntryLink(value, origin).kind).toBe('collab');
});

it('rejects other origins, credentials, query strings, malformed ids and non-links', () => {
  for (const value of [
    '', '   ', 'not a link', 'x'.repeat(2049),
    `https://evil.example/#/collab/${room}?invite=${invite}`,
    `https://evil.example/#/room/${key}`,
    `https://user:pass@space.example/#/collab/${room}?invite=${invite}`,
    `${origin}/?invite=${invite}#/collab/${room}`,
    `${origin}/other#/collab/${room}?invite=${invite}`,
    `${origin}/#/collab/${room}?invite=${invite.slice(1)}`,
    `${origin}/#/collab/${room}?invite=${invite}&next=x`,
    `${origin}/#/collab/${room.toUpperCase()}?invite=${invite}`,
    `${origin}/#/collab/${room.slice(1)}?invite=${invite}`,
    `javascript:alert(1)//#/collab/${room}`,
    room, invite,
  ]) expect(classifyEntryLink(value, origin)).toEqual({ kind: 'invalid' });
});
