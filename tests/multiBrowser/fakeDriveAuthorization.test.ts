import { expect, it } from 'vitest';
import { FakeDrive } from './fixtures/fakeDrive';

it('rejects metadata changes by a viewer without altering the shared folder', async () => {
  const drive = new FakeDrive();
  const owner = drive.addAccount('alice@example.test');
  const viewer = drive.addAccount('bob@example.test');
  const outsider = drive.addAccount('charlie@example.test');
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const created = await drive.fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'board', mimeType: 'application/vnd.google-apps.folder' })
  });
  const { id } = await created.json() as { id: string };
  drive.grant('board', 'bob@example.test', 'reader');
  const url = `https://www.googleapis.com/drive/v3/files/${id}`;
  const response = await drive.fetch(url, { method: 'PATCH', headers: auth(viewer), body: JSON.stringify({ name: 'changed', trashed: true }) });
  expect(response.status).toBe(403);
  expect((await drive.fetch(url, { headers: auth(outsider) })).status).toBe(404);
  const ownerView = await drive.fetch(url, { headers: auth(owner) });
  expect(ownerView.status).toBe(200);
  expect(await ownerView.json()).toMatchObject({ name: 'board', trashed: false });
});

it('permits an editor to update metadata and rejects unknown credentials', async () => {
  const drive = new FakeDrive();
  const owner = drive.addAccount('alice@example.test');
  const editor = drive.addAccount('bob@example.test');
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const created = await drive.fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'board', mimeType: 'application/vnd.google-apps.folder' })
  });
  const { id } = await created.json() as { id: string };
  drive.grant('board', 'bob@example.test', 'writer');
  const url = `https://www.googleapis.com/drive/v3/files/${id}`;
  expect((await drive.fetch(url, { method: 'PATCH', headers: auth('unknown'), body: JSON.stringify({ name: 'bad' }) })).status).toBe(401);
  expect((await drive.fetch(url, { method: 'PATCH', headers: auth(editor), body: JSON.stringify({ name: 'renamed' }) })).status).toBe(200);
  expect(await (await drive.fetch(url, { headers: auth(owner) })).json()).toMatchObject({ name: 'renamed', trashed: false });
});
