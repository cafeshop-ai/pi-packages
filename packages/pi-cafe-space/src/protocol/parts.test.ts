import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyEvent, decodeWireMessage, type EventEnvelope, type SessionSnapshot } from './index.js';
const root = new URL('../../protocol/fixtures/parts/', import.meta.url);
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record.$repeat) {
    const spec = record.$repeat as { text: string; count: number };
    if (!Number.isSafeInteger(spec.count) || spec.count < 0 || spec.count * spec.text.length > 1_048_576) throw new Error('Invalid fixture repeat');
    return spec.text.repeat(spec.count);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item)]));
}
function load(name: string): unknown { return expand(JSON.parse(readFileSync(new URL(name, root), 'utf8'))); }
interface Fixture {
  id: string; operation: 'decode' | 'applyEvent'; inputTemplate?: unknown;
  snapshot: SessionSnapshot; envelope: EventEnvelope;
  expected: { accepted: boolean; value?: unknown; code?: string };
}
describe('reviewed optional parts contract', () => {
  const fixtures = ['codec.json', 'reducer.json', 'budget-reducer.json'].flatMap(name => load(name) as Fixture[]);
  for (const fixture of fixtures) it(fixture.id, () => {
    const before = JSON.stringify(fixture);
    const run = () => fixture.operation === 'decode'
      ? decodeWireMessage(JSON.stringify(fixture.inputTemplate))
      : applyEvent(fixture.snapshot, fixture.envelope);
    if (fixture.expected.accepted) expect(run()).toStrictEqual(fixture.expected.value);
    else expect(run).toThrow();
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it('preserves exact ordered tool ownership, replacement output and formal empty/error results', () => {
    const fixture = load('ordered.json') as { initial: SessionSnapshot; events: EventEnvelope[]; expectedFinal: SessionSnapshot };
    let snapshot = fixture.initial;
    for (const input of fixture.events) {
      const before = JSON.stringify(snapshot);
      const event = decodeWireMessage(JSON.stringify(input));
      if (event.type !== 'event') throw new Error('Fixture event expected');
      const next = applyEvent(snapshot, event);
      expect(JSON.stringify(snapshot)).toBe(before);
      snapshot = next;
    }
    expect(snapshot).toStrictEqual(fixture.expectedFinal);
    const reconnected = decodeWireMessage(JSON.stringify({ type: 'snapshot', hostId: 'host-a', snapshot }));
    expect(reconnected).toStrictEqual({ type: 'snapshot', hostId: 'host-a', snapshot });
  });
});
