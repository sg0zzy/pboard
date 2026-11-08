import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeScreen } from '../src/screens/HomeScreen';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function noticeFor(cloud: Parameters<typeof HomeScreen>[0]['cloud']): string {
  const onNotice = vi.fn();
  act(() => root.render(<HomeScreen boards={[]} onOpen={vi.fn()} onSettings={vi.fn()} onCreate={vi.fn()} onNotice={onNotice} cloud={cloud} />));
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Google Drive integration"]')!.click());
  return onNotice.mock.calls[0]![0];
}

it('reports the real Drive state instead of a placeholder', () => {
  expect(noticeFor(null)).toContain('Google Drive is not connected');
  expect(noticeFor({ connected: false, error: '', lastSynced: '' })).toContain('Open Settings to connect it');
  const connected = noticeFor({ connected: true, error: '', lastSynced: '11:02' });
  expect(connected).toContain('Google Drive connected');
  expect(connected).toContain('Last synced: 11:02');
  expect(connected).not.toContain('not connected');
  expect(noticeFor({ connected: true, error: '', lastSynced: '' })).not.toContain('Last synced');
  expect(noticeFor({ connected: true, error: 'Token expired', lastSynced: '11:02' })).toContain('Token expired');
});
