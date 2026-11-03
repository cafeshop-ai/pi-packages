import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../i18n';
import { ManagedSessionDialog, type ManagedController } from './ManagedSessions';

it('submits the opaque Codex target key without a native session ID', async () => {
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const operate = vi.fn(); const targetKey = 'b'.repeat(64);
  function Harness() {
    const [project, setProject] = useState('work'); const [name, setName] = useState('Borrowed Codex');
    const control = {
      dialog: { mode: 'create' as const, trigger: document.createElement('button'), key: 'view', id: '12345678-1234-4123-8123-123456789abc' },
      key: 'view', supported: true, enabled: true, canManage: true, busy: false, error: null,
      agent: 'codex-acp', attachExisting: true, targetKey,
      inventory: { projects: [{ id: 'work', name: 'Work', room: 'main', cwd: 'C:/work' }], sessions: [], agents: ['pi', 'codex-acp'], acpAttach: true, maxActive: 8 },
      threads: [{ key: targetKey, projectId: 'work', name: 'Loaded task', cwd: 'C:/work', status: 'idle' }], threadsTruncated: false, threadsLoading: false, threadsError: null,
      name, project, setName, setProject, setTargetKey: vi.fn(), setAttachExisting: vi.fn(), setAgent: vi.fn(), setThreadsError: vi.fn(), setThreadRevision: vi.fn(), setDialog: vi.fn(), operate,
    } as unknown as ManagedController;
    return <ManagedSessionDialog control={control} />;
  }
  render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>);
  const create = screen.getByRole('button', { name: 'Create' });
  expect(create).toBeEnabled();
  await act(async () => fireEvent.click(create));
  await waitFor(() => expect(operate).toHaveBeenCalledOnce());
  const request = operate.mock.calls[0]![0];
  expect(request).toMatchObject({ operation: 'create', agent: 'codex-acp', targetKey });
  expect(JSON.stringify(request)).not.toContain('87654321-4321-4abc-8def-123456789abc');
});
