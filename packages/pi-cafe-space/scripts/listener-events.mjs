// Unified room listener, the pure part (docs/LISTENER.md): given what the listener has seen and
// one read page, which events the agent should get, and how each reads as one line. No I/O and
// no clock, so space-agent, the Pi extension and the shared fixtures all agree on the output.
// Event fields never use the names the outbox adds (id, batch, at): a task is `task`, a message time `sentAt`.

/** More new messages than this in one page become a single backlog event instead of a flood. */
export const maxBatchMessages = 20;
/** Message text in an event is cut to this many characters; `show <seq>` prints it whole. */
export const maxText = 1500;

const signature = t => JSON.stringify([t.status, t.assignee ?? '', t.title, t.result ?? 0, t.goalId ?? 0]);
const waitKey = st => [st?.since ?? '', st?.ref ?? 0, st?.detail ?? ''].join('|');
const cut = text => { const chars = [...String(text)]; return chars.length > maxText ? { text: chars.slice(0, maxText).join(''), truncated: true } : { text: String(text) }; };

/**
 * Events for one page. `seen` is the listener's memory and is updated in place. `fresh` are the
 * page's messages newer than the stored cursor; `goalConsumed` is the last Goal revision the agent
 * confirmed. On the first page (empty memory) members and tasks are only remembered: the hello
 * event summarises them, and later pages report changes. Waits on you and an unconfirmed Goal are
 * reported at once, since they ask for action.
 */
export function pageEvents(seen, page, fresh, me, goalConsumed = 0) {
  const events = [];
  seen.names = { ...(seen.names ?? {}) };
  for (const m of page.members ?? []) seen.names[m.id] = m.name;

  const others = fresh.filter(x => x.memberId !== me);
  if (others.length > maxBatchMessages) events.push({ type: 'backlog', from: others[0].seq, to: others.at(-1).seq, count: others.length });
  else for (const x of others) events.push({ type: 'msg', seq: x.seq, from: x.memberId, ...(x.to ? { to: x.to } : {}), ...(x.replyTo ? { replyTo: x.replyTo } : {}), ...cut(x.text), sentAt: x.at });

  if (Array.isArray(page.members)) {
    const before = seen.members;
    seen.members = Object.fromEntries(page.members.map(m => [m.id, !!m.removed]));
    if (before) for (const m of page.members) {
      if (!(m.id in before) && !m.removed) events.push({ type: 'member', change: 'joined', member: m.id, kind: m.kind });
      else if (before[m.id] === false && m.removed) events.push({ type: 'member', change: 'left', member: m.id });
    }
  }

  if (Array.isArray(page.tasks)) {
    const before = seen.tasks; const now = Object.fromEntries(page.tasks.map(t => [t.id, signature(t)]));
    if (before) {
      for (const t of page.tasks) {
        const base = { type: 'task', task: t.id, title: t.title, status: t.status, ...(t.assignee ? { assignee: t.assignee } : {}) };
        if (!(t.id in before)) events.push({ ...base, change: 'created' });
        else if (before[t.id] !== now[t.id]) {
          const [status, assignee] = JSON.parse(before[t.id]);
          events.push({ ...base, change: 'updated', ...(status !== t.status ? { was: status } : {}), ...(assignee !== (t.assignee ?? '') ? { reassigned: true } : {}), ...(t.result ? { result: t.result } : {}) });
        }
      }
      for (const id of Object.keys(before)) if (!(id in now)) events.push({ type: 'task', change: 'deleted', task: Number(id), title: seen.taskTitles?.[id] ?? '' });
    }
    seen.tasks = now; seen.taskTitles = Object.fromEntries(page.tasks.map(t => [t.id, t.title]));
  }

  if (Number.isSafeInteger(page.goalRevision)) {
    const shown = Math.max(seen.goalShown ?? 0, goalConsumed);
    if (page.goalRevision > shown) events.push({ type: 'goal', revision: page.goalRevision, ...(page.goal ? { goal: page.goal.id, status: page.goal.status, title: page.goal.title } : { deleted: true }) });
    seen.goalShown = Math.max(shown, page.goalRevision);
  }

  if (typeof page.aiPaused === 'boolean') {
    if (seen.paused !== undefined && seen.paused !== page.aiPaused) events.push({ type: 'pause', paused: page.aiPaused });
    seen.paused = page.aiPaused;
  }

  if (Array.isArray(page.waitingOnYou)) {
    const before = seen.waits ?? {}; const now = {};
    for (const id of page.waitingOnYou) {
      const st = page.states?.[id] ?? {}; now[id] = waitKey(st);
      if (before[id] !== now[id]) events.push({ type: 'waiting', change: 'started', member: id, waitingFor: st.waitingFor ?? 'member', detail: st.detail ?? '', ...(st.ref ? { ref: st.ref } : {}) });
    }
    for (const id of Object.keys(before)) if (!(id in now)) events.push({ type: 'waiting', change: 'ended', member: id });
    seen.waits = now;
  }
  return events;
}

/** The start-of-run summary: counts only, never the board itself. */
export function helloEvent(page, me) {
  const open = (page.tasks ?? []).filter(t => t.status !== 'done');
  return { type: 'hello', title: page.title ?? '', members: (page.members ?? []).filter(m => !m.removed).length, openTasks: open.length, mine: open.filter(t => t.assignee === me).length,
    ...(page.goal ? { goal: { revision: page.goalRevision, status: page.goal.status } } : {}), paused: page.aiPaused === true, waitingOnYou: (page.waitingOnYou ?? []).length };
}

const flat = text => String(text).replace(/\r?\n/g, ' ⏎ ').replace(/[\t ]+/g, ' ').trim();
const who = (names, id, me) => id === me ? '你' : names?.[id] ?? (id ? id.slice(0, 6) : '?');
const taskStatus = { todo: 'todo', doing: 'doing', done: 'done' };

/** One line per event, with a fixed prefix the model can scan. */
export function formatEvent(e, names = {}, me = '') {
  switch (e.type) {
    case 'hello': return `[room ${flat(e.title)}] 成员 ${e.members} · 未完成任务 ${e.openTasks}${e.mine ? `（${e.mine} 项归你）` : ''}，看板用 board 查看${e.goal ? ` · Goal r${e.goal.revision} ${e.goal.status}` : ''}${e.paused ? ' · AI 发言已暂停' : ''}${e.waitingOnYou ? ` · ${e.waitingOnYou} 人在等你` : ''}`;
    case 'msg': {
      const head = `[msg #${e.seq} ${who(names, e.from, me)}${e.to ? ` → ${who(names, e.to, me)}` : ''}${e.replyTo ? ` ↩#${e.replyTo}` : ''}] `;
      const body = flat(e.text), hint = `…（全文：show ${e.seq}）`;
      const line = head + body + (e.truncated ? hint : '');
      if (Buffer.byteLength(line, 'utf8') <= 2048) return line;
      let remaining = 2048 - Buffer.byteLength(head + hint, 'utf8'), short = '';
      for (const char of body) {
        remaining -= Buffer.byteLength(char, 'utf8');
        if (remaining < 0) break;
        short += char;
      }
      return head + short + hint;
    }
    case 'backlog': return `[backlog #${e.from}–#${e.to} 共 ${e.count} 条] 没有逐条推送：用 next 分批读取，处理后 done`;
    case 'task': {
      const owner = e.assignee ? ` ${who(names, e.assignee, me)}` : ' 未指派';
      if (e.change === 'created') return `[task #${e.task} 新建 ${taskStatus[e.status] ?? e.status}${owner}] ${flat(e.title)}`;
      if (e.change === 'deleted') return `[task #${e.task} 已删除] ${flat(e.title)}`;
      return `[task #${e.task} ${e.was ? `${e.was}→` : ''}${e.status}${owner}${e.result ? ` 结果 #${e.result}` : ''}] ${flat(e.title)}`;
    }
    case 'goal': return e.deleted ? `[goal r${e.revision} 已删除] 停止该目标的工作；确认：done-goal ${e.revision}` : `[goal r${e.revision} ${e.status}] ${flat(e.title)}（goal read 查看；确认：done-goal ${e.revision}）`;
    case 'pause': return e.paused ? '[pause on] 房间已暂停 AI 发言：只读，不发帖' : '[pause off] 房间已恢复 AI 发言';
    case 'member': return e.change === 'joined' ? `[member+ ${who(names, e.member, me)} (${e.kind})]` : `[member- ${who(names, e.member, me)}]`;
    case 'waiting': return e.change === 'started' ? `[waiting-on-you ${who(names, e.member, me)} ${e.waitingFor}${e.ref ? ` #${e.ref}` : ''}] ${flat(e.detail)}` : `[waiting-ended ${who(names, e.member, me)}]`;
    case 'health': return e.ok ? '[listener 已恢复]' : '[listener 连接中断，自动重连中]';
    case 'stop': return `[stop ${flat(e.reason)}] 监听已停止`;
    default: return `[${e.type}]`;
  }
}
