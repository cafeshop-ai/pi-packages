import { useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import { historyCacheKey, scopeKey } from '../../state/CollabStore';
import { useReadCommand } from '../../components/ui/useReadCommand';
import { Conversation } from '../chat/components/Conversation';
import { historyHref, historyIdFromPath, parseSession, parseSessions, groupSessions } from './data';
import { Icon } from '../../components/ui/Icon';
import { Button } from '../../components/ui/Controls';
import styles from './History.module.scss';
import { SessionActions } from './SessionActions';
export function HistoryList({ owner, roomBase = '', query = '' }: { owner: AppOwner; roomBase?: string; query?: string }) {
  const { t, i18n } = useTranslation(); const state = useCollabStore(owner.store, s => s);
  const scope = owner.store.scope(); const request = useReadCommand(owner, scope);
  const host = scope ? state.hosts.get(scope.hostId) : undefined;
  // Reuse only the existing exact-scope/revision cache while refreshing a view.
  const cached = scope && host ? state.history.get(historyCacheKey(scope, host.revision, 'list_sessions'))?.data : undefined;
  const data = parseSessions(state.panels.sessions ?? cached);
  const key = scope ? scopeKey(scope) : '';
  useEffect(() => {
    if (scope && state.connection.status === 'authenticated') void request.run({ name: 'list_sessions' });
  }, [owner, key, state.connection.status, host?.snapshot?.sessionName]);
  const groups = groupSessions(data?.sessions ?? [], query);
  // An offline host is allowed: the Relay may have a context-bound cached read.
  return <section className={styles.list} aria-label={t('history')}><div className={styles.heading}><h2>{t('history')}</h2>
    <Button variant="quiet" aria-label={t('loadHistory')} title={t('loadHistory')} loading={request.loading} disabled={!scope || state.connection.status !== 'authenticated' || request.loading} onClick={() => void request.run({ name: 'list_sessions' })}><Icon name="refresh" /></Button></div>
    {!data && <p className={styles.hint}>{t('historyHint')}</p>}
    {data?.sessions.length === 0 && <p className={styles.hint}>{t('emptyHistory')}</p>}
    {request.error && <p role="alert">{t('readFailed')} <code>{request.error}</code></p>}
    {request.loading && <p role="status" className={styles.hint}>{t('loading')}</p>}
    {data && query.trim() && Object.values(groups).every(sessions => sessions.length === 0) && <p className={styles.hint}>{t('noSessionMatches')}</p>}
    {Object.entries(groups).map(([group, sessions]) => sessions.length > 0 && <div key={group}><h3>{t(group)}</h3><ul>{sessions.map((session, index) => { const href = historyHref(session.sessionId); const title = session.name || session.firstMessage || session.sessionId; const date = new Date(session.modified); return <li key={JSON.stringify([session.sessionId, index])}>{href ? <NavLink to={roomBase + href} title={title} aria-label={title}><Icon name="message" /><span className={styles.session}><strong>{title}</strong><small><span>{t('messageCount', { count: session.messageCount })}</span>{Number.isFinite(+date) && <time dateTime={session.modified}>{date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}</time>}</small></span></NavLink> : session.sessionId}</li>; })}</ul></div>)}
    {data?.historyTruncated && <p>{t('contentTruncated')}</p>}
  </section>;
}
export function HistoryDetail({ owner, roomBase = '' }: { owner: AppOwner; roomBase?: string }) {
  const { t } = useTranslation();
  // Router params additionally unescape %2F after path decoding. That corrupts
  // a literal %2F inside an opaque ID; decode the raw location segment once.
  const sessionId = historyIdFromPath(useLocation().pathname);
  const state = useCollabStore(owner.store, s => s);
  const scope = owner.store.scope(); const key = scope ? scopeKey(scope) : '';
  const request = useReadCommand(owner, scope);
  const validId = typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256;
  useEffect(() => {
    if (validId && scope && state.connection.status === 'authenticated') void request.run({ name: 'get_session', sessionId });
    // The scope tuple is the stable value dependency; fresh wrapper objects or
    // result commits must not trigger another identical history read.
  }, [owner, key, sessionId, state.connection.status]);
  const data = validId ? parseSession(state.panels.session, sessionId) : null;
  if (!validId) return <p role="alert">{t('invalidRoute')}</p>;
  return <>
    <header className={styles.detailHeader}><div><span>{t('historyContext')}</span><h2>{data?.snapshot.sessionName || sessionId}</h2></div><Link to={roomBase || '/'}><Icon name="back" />{t('returnLive')}</Link></header>
    {data && <SessionActions owner={owner} roomBase={roomBase} sessionId={sessionId} title={data.snapshot.sessionName ?? undefined} />}
    {request.error && <p role="alert">{t('readFailed')} <code>{request.error}</code></p>}
    {request.loading && <p role="status">{t('loading')}</p>}
    {data && scope ? <Conversation snapshot={data.snapshot} scope={{ ...scope, streamId: 'history', sessionId: data.snapshot.sessionId }} readOnly /> : !request.loading && !request.error ? <p>{t('selectHost')}</p> : null}
  </>;
}
