import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import { useReadCommand } from '../../components/ui/useReadCommand';
import { childPath, parseDirectory, parseFile } from './data';
import styles from './FilesPane.module.scss';
import { Icon } from '../../components/ui/Icon';
import { Button } from '../../components/ui/Controls';
export function FilesPane({ owner }: { owner: AppOwner }) {
  const { t } = useTranslation(); const state = useCollabStore(owner.store, s => s);
  const scope = owner.store.scope(); const host = state.selectedHostId ? state.hosts.get(state.selectedHostId) : undefined;
  const enabled = state.connection.status === 'authenticated' && !!scope && !!host && host.info.connected && host.info.ready !== false && !host.stale;
  const request = useReadCommand(owner, scope);
  const [path, setPath] = useState('.'); const [selected, setSelected] = useState<string | null>(null);
  const directory = parseDirectory(state.panels.directory); const file = parseFile(state.panels.file);
  const visibleDirectory = directory?.path === path ? directory : null;
  const preview = file?.path === selected ? file : null;
  const load = (nextPath: string) => { setPath(nextPath); setSelected(null); void request.run({ name: 'list_dir', path: nextPath }); };
  return <section className={styles.files} aria-label={t('files')}>
    <h2>{t('files')}</h2><Button className={styles.load} aria-label={t('loadFiles')} loading={request.loading} disabled={!enabled || request.loading} onClick={() => load(path)}><Icon name="refresh" />{t('loadFiles')}</Button>
    {path !== '.' && <Button variant="quiet" disabled={!enabled} onClick={() => load(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')}><Icon name="back" />{t('parentDirectory')}</Button>}
    <p className={styles.breadcrumb}><Icon name="folder" /><span className={styles.path}>{path}</span></p>
    {!visibleDirectory && !request.loading && <p className={styles.hint}>{t('filesHint')}</p>}
    {visibleDirectory?.entries.length === 0 && <p className={styles.hint}>{t('emptyFiles')}</p>}
    {request.loading && <p role="status">{t('loading')}</p>}{request.error && <p role="alert">{t('readFailed')} <code>{request.error}</code></p>}
    <ul>{visibleDirectory?.entries.map((entry, index) => {
      const target = childPath(path, entry.name);
      return <li key={JSON.stringify([entry.name, index])}><Button variant="quiet" aria-pressed={selected === target} disabled={!enabled || !target || entry.kind === 'link'} onClick={() => {
        if (!target) return;
        if (entry.kind === 'directory') load(target);
        else { setSelected(target); void request.run({ name: 'read_file', path: target, offset: 0 }); }
      }}><Icon name={entry.kind === 'directory' ? 'folder' : 'file'} /><span>{entry.name}</span></Button></li>;
    })}</ul>
    {visibleDirectory?.truncated && <p>{t('contentTruncated')}</p>}
    {selected && <section aria-label={t('filePreview')}><h3 className={styles.path}>{selected}</h3>{preview && <>
      <pre>{preview.content}</pre><p>{preview.offset}–{preview.offset + preview.bytesRead} / {preview.size} {t('bytes')}</p>
      {preview.truncated && <><p>{t('contentTruncated')}</p><Button disabled={!enabled || request.loading || preview.bytesRead === 0} onClick={() => void request.run({ name: 'read_file', path: selected, offset: preview.offset + preview.bytesRead })}>{t('nextPage')}</Button></>}
    </>}</section>}
  </section>;
}
