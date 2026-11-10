import { expect, it, vi } from 'vitest';
import { createHintDiscovery } from '../../src/sync/hintDiscovery';

it('shares a discovery for a burst of hints and refreshes after the short window', async () => {
  let now = 0, account = 'account-a';
  let finish!: (value: string[]) => void;
  const discover = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(['new board']).mockResolvedValueOnce(['other account']);
  const lookup = createHintDiscovery({ account: async () => account, discover, now: () => now, reuseMs: 5_000 });
  const first = lookup(), second = lookup();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(discover).toHaveBeenCalledTimes(1);
  finish(['board']);
  expect(await Promise.all([first, second])).toEqual([['board'], ['board']]);
  now = 4_999;
  expect(await lookup()).toEqual(['board']);
  now = 5_001;
  expect(await lookup()).toEqual(['new board']);
  account = 'account-b';
  expect(await lookup()).toEqual(['other account']);
  expect(discover).toHaveBeenCalledTimes(3);
});

it('does not cache failed Drive scans', async () => {
  const discover = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['board']);
  const lookup = createHintDiscovery({ account: async () => 'account', discover });
  await expect(lookup()).rejects.toThrow('offline');
  await expect(lookup()).resolves.toEqual(['board']);
  expect(discover).toHaveBeenCalledTimes(2);
});
