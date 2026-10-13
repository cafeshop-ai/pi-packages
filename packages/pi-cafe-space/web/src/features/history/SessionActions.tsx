import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { isCommandPayload, type CommandPayload } from '../../../../src/protocol/index';
import type { AppOwner } from '../../app/owner';
import { scopeKey } from '../../state/CollabStore';
import { useCollabStore } from '../../state/useCollabStore';
import { useRemoteState } from '../../services/remote/useRemoteState';
import { Button, Input } from '../../components/ui/Controls';
import { Drawer } from '../../components/ui/Drawer';
import { Icon } from '../../components/ui/Icon';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/shadcn/field';
import styles from './History.module.scss';

export interface SessionActionRequest { mode: 'new_session' | 'rename_session'; trigger: HTMLElement; title?: string }
export function SessionActions({ owner, roomBase = '', sessionId, title, request }: { owner: AppOwner; roomBase?: string; sessionId?: string; title?: string; request?: SessionActionRequest }) {
  const { t } = useTranslation(); const navigate = useNavigate(); const id = useId();
  const state = useCollabStore(owner.store, s => s); const scope = owner.store.scope();
  useRemoteState(owner.remote);
  const host = scope ? state.hosts.get(scope.hostId) : undefined; const snapshot = host?.snapshot;
  const key = JSON.stringify([scope && scopeKey(scope), state.connection.generation, state.viewGeneration]);
  const [dialog, setDialog] = useState<{ mode: 'new_session' | 'rename_session' | 'resume_session'; trigger: HTMLElement; key: string } | null>(null);
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const latch = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDialog(null); setError(null); }, [key]);
  const enabled = state.connection.status === 'authenticated' && !!scope && owner.remote.canRequestWrite() && !!host && !host.stale && host.info.connected && host.info.ready !== false && snapshot?.sessionControl === true && snapshot.phase === 'idle' && !snapshot.hasPendingMessages;
  const open = (mode: NonNullable<typeof dialog>['mode'], trigger: HTMLElement) => { setName(snapshot?.sessionName ?? ''); setError(null); setDialog({ mode, trigger, key }); };
  useEffect(() => { if (request) { open(request.mode, request.trigger); if (request.title !== undefined) setName(request.title); } }, [request]);
  const label = (mode: NonNullable<typeof dialog>['mode']) => t(mode === 'new_session' ? 'newSession' : mode === 'rename_session' ? 'renameSession' : 'resumeSession');
  const payload: CommandPayload | null = dialog?.mode === 'rename_session' ? { name: 'rename_session', title: name.trim() } : dialog?.mode === 'resume_session' && sessionId ? { name: 'resume_session', sessionId } : dialog?.mode === 'new_session' ? { name: 'new_session' } : null;
  const run = async () => {
    if (!enabled || !scope || !dialog || dialog.key !== key || !payload || !isCommandPayload(payload) || latch.current) return;
    latch.current = true; setBusy(true); setError(null);
    const view = state.viewGeneration;
    try {
      const result = await owner.execute(payload, scope);
      if (result.status === 'unknown') owner.store.notice('RESULT_UNKNOWN');
      if (!owner.store.isScope(scope) || owner.store.getSnapshot().viewGeneration !== view) return;
      if (result.status === 'rejected' || result.status === 'unknown') { setError(result.code ?? 'COMMAND_ERROR'); return; }
      setDialog(null);
      if (payload.name !== 'rename_session') {
        if (result.status === 'dispatched') owner.store.notice('SESSION_SWITCH_DISPATCHED');
        navigate(roomBase || '/');
      }
    } finally { latch.current = false; setBusy(false); }
  };
  return <div className={styles.actions}>
    {sessionId ? <Button disabled={!enabled || busy} onClick={event => open('resume_session', event.currentTarget)}>{t('resumeSession')}</Button> : !request && <Button variant="quiet" aria-label={t('renameSession')} title={t('renameSession')} disabled={!enabled || busy} onClick={event => open('rename_session', event.currentTarget)}><Icon name="edit" /></Button>}
    {!request && snapshot && snapshot.sessionControl !== true && <p className={styles.hint}>{t('sessionReloadHint')}</p>}
    {dialog && <Drawer compact label={label(dialog.mode)} closeLabel={t('close')} restoreFocusTo={dialog.trigger} onClose={() => setDialog(null)}>
      <form className={styles.actionForm} onSubmit={event => { event.preventDefault(); void run(); }}><FieldGroup>
        <p className={styles.actionTarget}>{snapshot?.sessionName || scope?.sessionId}<small>{scope?.cwd}</small></p>
        {dialog.mode === 'rename_session' ? <Field><FieldLabel htmlFor={id}>{t('sessionTitle')}</FieldLabel><Input id={id} required maxLength={256} value={name} disabled={busy} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} /></Field> : <>
          {sessionId && <p>{t('resumeSession')}: {title || sessionId}</p>}
          <p>{t('sessionSwitchHint')}</p>
        </>}
        {error && <p role="alert">{t(`errors.${error}`, { defaultValue: t('commandRejected') })} <code>{error}</code></p>}
        {busy && <p role="status">{t('sessionWaiting')}</p>}
        <div className={styles.formActions}><Button variant="quiet" onClick={() => setDialog(null)}>{t('cancel')}</Button><Button type="submit" variant="primary" loading={busy} disabled={!enabled || busy || error === 'RESULT_UNKNOWN' || !payload || !isCommandPayload(payload)}>{t(dialog.mode === 'rename_session' ? 'saveSessionName' : dialog.mode === 'new_session' ? 'createSession' : 'confirmSessionAction')}</Button></div>
      </FieldGroup></form>
    </Drawer>}
  </div>;
}
