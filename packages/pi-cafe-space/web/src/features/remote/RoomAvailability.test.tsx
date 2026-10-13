import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { AppOwner } from '../../app/owner';
import { createI18n } from '../../i18n';
import { roomOnline } from '../../services/http/roomStatus';
import { RoomLogin } from './RoomEntry';
vi.mock('../../services/http/roomStatus', () => ({ roomOnline: vi.fn() }));
const check = vi.mocked(roomOnline), key = 'B' + 'A'.repeat(86), owners: AppOwner[] = [];
beforeEach(() => { check.mockReset(); });
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.restoreAllMocks(); });
async function setup() {
  const owner = new AppOwner(); owners.push(owner);
  const connect = vi.spyOn(owner, 'connectRoomLink').mockImplementation(() => {});
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const ui = (roomKey = key) => <I18nextProvider i18n={i18n}><RoomLogin owner={owner} roomKey={roomKey} /></I18nextProvider>;
  return { ...render(ui()), ui, connect };
}
it('checks before requesting a password and offers retry when the room comes online', async () => {
  let answer!: (online: boolean) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockResolvedValueOnce(true);
  const { connect } = await setup();
  expect(screen.getByRole('status')).toHaveTextContent('Checking room status');
  expect(screen.queryByLabelText('Room password', { exact: true })).not.toBeInTheDocument();
  await act(async () => answer(false));
  expect(screen.getByRole('status')).toHaveTextContent('Room is offline');
  expect(screen.queryByLabelText('Your nickname', { exact: true })).not.toBeInTheDocument();
  expect(connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByLabelText('Room password', { exact: true })).toHaveValue('');
  expect(check).toHaveBeenCalledTimes(2); expect(connect).not.toHaveBeenCalled();
});
it('does not misreport a failed status request as an offline room or wrong password', async () => {
  check.mockRejectedValue(Error('HTTP_503'));
  await setup();
  expect(await screen.findByText('Could not check room status')).toBeInTheDocument();
  expect(screen.queryByText('Room is offline')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Room password', { exact: true })).not.toBeInTheDocument();
});
it('aborts old-room checks and ignores late responses after navigation or unmount', async () => {
  let answer!: (online: boolean) => void;
  check.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockResolvedValueOnce(false);
  const view = await setup(), oldSignal = check.mock.calls[0]![1];
  view.rerender(view.ui('B' + 'C'.repeat(86)));
  expect(oldSignal.aborted).toBe(true);
  await screen.findByText('Room is offline');
  await act(async () => answer(true));
  expect(screen.queryByLabelText('Room password', { exact: true })).not.toBeInTheDocument();
  const currentSignal = check.mock.calls[1]![1]; view.unmount(); expect(currentSignal.aborted).toBe(true);
});
