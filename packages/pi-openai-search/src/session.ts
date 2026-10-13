import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { abortable, SearchError } from "./client.ts";
import { isWebUrl, references, resultReferences, type SearchCommands, type SearchResponse } from "./protocol.ts";

export const STATE_ENTRY = "openai-search-state";
const StateSchema = Type.Object({
  version: Type.Literal(1), owner: Type.String(), id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
  binding: Type.String({ pattern: "^(?:[a-f0-9]{64})?$" }),
  refs: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 1024 }),
}, { additionalProperties: false });
type State = Static<typeof StateSchema>;

export class SearchSession {
  private state?: State;
  private tail: Promise<void> = Promise.resolve();
  private append: (type: string, data: State) => void;
  constructor(append: (type: string, data: State) => void) { this.append = append; }

  restore(owner: string, branch: SessionEntry[], fresh = false): void {
    this.state = undefined;
    if (fresh) { this.reset(owner); return; }
    const entry = branch.findLast((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
    if (entry?.type === "custom" && Value.Check(StateSchema, entry.data) && entry.data.owner === owner) this.state = structuredClone(entry.data);
  }
  reset(owner: string): void {
    this.state = { version: 1, owner, id: randomUUID(), binding: "", refs: [] };
    this.persist();
  }
  prepare(owner: string, binding: string, commands: SearchCommands): string {
    if (!this.state || this.state.owner !== owner || this.state.binding !== binding) {
      this.state = { version: 1, owner, id: randomUUID(), binding, refs: [] };
      this.persist();
    }
    for (const ref of references(commands)) {
      if (!isWebUrl(ref) && !this.state.refs.includes(ref)) {
        throw new SearchError("Unknown or expired local search reference. After reset, branch/account/provider changes, search again or open the original URL.");
      }
    }
    return this.state.id;
  }
  remember(id: string, response: SearchResponse): void {
    if (this.state?.id !== id) return;
    // shortcut: retain 1024 recent references; use URLs or search again beyond this bound.
    this.state.refs = [...new Set([...this.state.refs, ...resultReferences(response)])].slice(-1024);
    this.persist();
  }
  private persist(): void { if (this.state) this.append(STATE_ENTRY, structuredClone(this.state)); }

  enqueue<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    // Codemode can issue concurrent nested calls even when the model-facing tool is sequential.
    const work = this.tail.then(() => { signal.throwIfAborted(); return task(); });
    this.tail = work.then(() => {}, () => {});
    return abortable(work, signal);
  }
}
