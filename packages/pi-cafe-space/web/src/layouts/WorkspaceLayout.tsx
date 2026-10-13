import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './WorkspaceLayout.module.scss';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/Controls';
import { Drawer } from '../components/ui/Drawer';
const subscribe = (notify: () => void) => { window.addEventListener('resize', notify); return () => window.removeEventListener('resize', notify); };
const viewport = () => window.innerWidth >= 1024 ? 'desktop' : window.innerWidth >= 768 ? 'tablet' : 'mobile';
export function useWorkspaceMode() { return useSyncExternalStore(subscribe, viewport, () => 'desktop' as const); }
export function WorkspaceLayout({ children, sidebar, files, header, mobileTitle = 'Café Space', mobileSubtitle, mobileActions }: { children: ReactNode; sidebar: ReactNode; files: ReactNode; header?: ReactNode; mobileTitle?: string; mobileSubtitle?: string; mobileActions?: ReactNode }) {
  const { t } = useTranslation(); const mode = useWorkspaceMode();
  const [drawer, setDrawer] = useState<'hosts' | 'files' | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true); const [filesOpen, setFilesOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const openDrawer = (kind: 'hosts' | 'files', element: HTMLElement) => { trigger.current = element; setDrawer(kind); };
  useEffect(() => { setDrawer(null); }, [mode]);
  return <div className={styles.layout} data-layout={mode} data-sidebar-open={sidebarOpen} data-files-open={filesOpen}>
    <header className={styles.toolbar}>
      {mode === 'mobile' ? <>
        <Button className={styles.mobileInstance} variant="quiet" aria-label={t('hosts')} aria-expanded={drawer === 'hosts'} onClick={event => openDrawer('hosts', event.currentTarget)}><Icon name="hosts" /><span><strong>{mobileTitle}</strong><small>{mobileSubtitle}</small></span><Icon name="chevron" /></Button>
        <div className={styles.mobileActions}><Button variant="quiet" aria-label={t('files')} aria-expanded={drawer === 'files'} onClick={event => openDrawer('files', event.currentTarget)}><Icon name="folder" /></Button>{mobileActions}</div>
      </> : <>
      <Button variant="quiet" aria-label={t('hosts')} aria-expanded={mode === 'desktop' ? sidebarOpen : drawer === 'hosts'} onClick={event => mode === 'desktop' ? setSidebarOpen(value => !value) : openDrawer('hosts', event.currentTarget)}><Icon name="sidebar" /><span className={styles.toggleLabel}>{t('hosts')}</span></Button>
      {header}
      <Button className={styles.filesToggle} variant="quiet" aria-label={t('files')} aria-expanded={mode === 'desktop' ? filesOpen : drawer === 'files'} onClick={event => mode === 'desktop' ? setFilesOpen(value => !value) : openDrawer('files', event.currentTarget)}><Icon name="folder" /><span>{t('files')}</span></Button>
      </>}
    </header>
    <div className={styles.grid} inert={drawer ? true : undefined}>
      {mode === 'desktop' && sidebarOpen && <aside className={styles.sidebar} aria-label={t('hosts')}>{sidebar}</aside>}
      {children}
      {mode === 'desktop' && filesOpen && <aside className={styles.files}>{files}</aside>}
    </div>
    {drawer && <Drawer label={t(drawer === 'hosts' ? 'hosts' : 'files')} closeLabel={t('close')} onClose={() => setDrawer(null)} restoreFocusTo={trigger.current}>{drawer === 'hosts' ? sidebar : files}</Drawer>}
  </div>;
}
