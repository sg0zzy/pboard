import { expect, it, vi } from 'vitest';
import { createDriveRoundReads } from '../../src/sync/driveRoundReads';

const file = 'https://www.googleapis.com/drive/v3/files/file-1?alt=media';
const auth = (token = 'one') => ({ headers: { Authorization: `Bearer ${token}` } });

it('reads a file once per round, gives every caller its own body and refreshes next round', async () => {
  const network = vi.fn(async () => new Response('content'));
  const reads = createDriveRoundReads(network as typeof fetch);
  await reads.run(async () => {
    const [one, two] = await Promise.all([reads.fetch(file, auth()), reads.fetch(file, auth())]);
    expect(await one.text()).toBe('content');
    expect(await two.text()).toBe('content');
    expect(await (await reads.fetch(file, auth())).text()).toBe('content');
    expect(network).toHaveBeenCalledTimes(1);
  });
  await reads.run(async () => { await reads.fetch(file, auth()); });
  await reads.fetch(file, auth());
  expect(network).toHaveBeenCalledTimes(3);
});

it('does not share accounts, permission metadata, failures, ranges or abortable requests', async () => {
  const network = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockImplementation(async () => new Response('ok'));
  const reads = createDriveRoundReads(network as typeof fetch);
  const metadata = 'https://www.googleapis.com/drive/v3/files/file-1?fields=capabilities';
  await reads.run(async () => {
    expect((await reads.fetch(file, auth())).status).toBe(404);
    await reads.fetch(file, auth());
    await reads.fetch(file, auth('two'));
    await reads.fetch(metadata, auth()); await reads.fetch(metadata, auth());
    await reads.fetch(file, { headers: { Authorization: 'Bearer one', Range: 'bytes=0-1' } });
    await reads.fetch(file, { ...auth(), signal: new AbortController().signal });
    expect(network).toHaveBeenCalledTimes(7);
  });
});

it('invalidates media after a Drive write and clears the scope on failure', async () => {
  let value = 'before';
  const network = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') { value = 'after'; return new Response('{}'); }
    return new Response(value);
  });
  const reads = createDriveRoundReads(network as typeof fetch);
  await expect(reads.run(async () => {
    expect(await (await reads.fetch(file, auth())).text()).toBe('before');
    await reads.fetch('https://www.googleapis.com/upload/drive/v3/files/file-1', { method: 'PATCH', ...auth() });
    expect(await (await reads.fetch(file, auth())).text()).toBe('after');
    throw new Error('round failed');
  })).rejects.toThrow('round failed');
  await reads.fetch(file, auth());
  expect(network).toHaveBeenCalledTimes(4);
});

it('keeps an already-read file when a different file is updated', async () => {
  const network = vi.fn(async () => new Response('content'));
  const reads = createDriveRoundReads(network as typeof fetch);
  await reads.run(async () => {
    await reads.fetch(file, auth());
    await reads.fetch('https://www.googleapis.com/upload/drive/v3/files/another-file', { method: 'PATCH', ...auth() });
    await reads.fetch(file, auth());
    expect(network).toHaveBeenCalledTimes(2);
  });
});

it('can start a fresh view for an explicit refresh during another round', async () => {
  let value = 'before';
  const network = vi.fn(async () => new Response(value));
  const reads = createDriveRoundReads(network as typeof fetch);
  await reads.run(async () => {
    expect(await (await reads.fetch(file, auth())).text()).toBe('before');
    value = 'after';
    reads.invalidate();
    expect(await (await reads.fetch(file, auth())).text()).toBe('after');
    expect(network).toHaveBeenCalledTimes(2);
  });
});
