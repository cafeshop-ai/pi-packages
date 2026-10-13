import { describe, expect, it } from 'vitest';
import { parseRoomRoute, roomHref } from './roomRoute';

describe('room hash paths', () => {
  it('extracts a validated room without decoding opaque history IDs', () => {
    expect(parseRoomRoute('/rooms/manual-trial')).toEqual({ valid: true, roomId: 'manual-trial', base: '/rooms/manual-trial', pagePath: '/' });
    expect(parseRoomRoute('/rooms/%6dain/history/saved%2F%252F')).toEqual({ valid: true, roomId: 'main', base: '/rooms/main', pagePath: '/history/saved%2F%252F' });
    expect(parseRoomRoute('/rooms/main/').valid).toBe(true);
    expect(roomHref('a_1-Z')).toBe('/rooms/a_1-Z');
  });
  it.each(['/rooms', '/rooms/', '/rooms//', '/rooms/%', '/rooms/%2F', '/rooms/%252F', '/rooms/%00', '/rooms/main%0A', '/rooms/main%0D', '/rooms/main%20', '/rooms/a b', '/rooms/-bad', '/rooms/' + 'a'.repeat(65), '/rooms/%E4%B8%AD'])('rejects malformed room %s without falling back to cached room', path => {
    expect(parseRoomRoute(path)).toEqual({ valid: false });
  });
  it('retains unscoped bookmarks and rejects invalid generated links', () => {
    expect(parseRoomRoute('/history/saved%252F')).toEqual({ valid: true, roomId: null, base: '', pagePath: '/history/saved%252F' });
    expect(parseRoomRoute('/')).toEqual({ valid: true, roomId: null, base: '', pagePath: '/' });
    expect(() => roomHref('bad/room')).toThrow();
    expect(() => roomHref('')).toThrow();
  });
});
