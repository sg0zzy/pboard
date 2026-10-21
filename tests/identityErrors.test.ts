import { expect, it } from 'vitest';
import { identityRejection } from '../src/collab/identityErrors';

it.each([
  ['directory_capacity', 'board limit'],
  ['pending_capacity', 'device request limit'],
  ['policy_conflict', 'older board sharing policy'],
  ['board_not_authorized', 'does not authorize'],
  ['google_token_rejected', 'Reconnect Google'],
  ['email_not_allowed', 'not admitted']
])('explains a 403 %s rejection without claiming enrollment is disabled', async (code, explanation) => {
  const error = await identityRejection(new Response(JSON.stringify({ code }), { status: 403 }));
  expect(error.message).toContain(code); expect(error.message).toContain(explanation);
  expect(error.message).not.toContain('enable identity enrollment');
});
it('distinguishes disabled/missing identity enrollment from rate limiting', async () => {
  expect((await identityRejection(new Response(null, { status: 404 }))).message).toContain('unavailable or disabled');
  expect((await identityRejection(new Response(null, { status: 429 }))).message).toContain('rate limit');
});
it.each(['<html>PRIVATE_TOKEN proxy error</html>', '{"code":"PRIVATE_TOKEN"}', '{"code":"__proto__"}', 'x'.repeat(5000)])('does not echo untrusted response bodies or unknown reason codes', async body => {
  const error = await identityRejection(new Response(body, { status: 403 }));
  expect(error.message).toContain('recognized reason code');
  expect(error.message).not.toContain('PRIVATE_TOKEN');
  expect(error.message).not.toContain('__proto__');
});
it('does not mistake missing board grant metadata for disabled identity enrollment', async () => {
  const error = await identityRejection(new Response(null, { status: 404 }), 'grant');
  expect(error.message).toContain('board authorization metadata is unavailable');
  expect(error.message).not.toContain('disabled');
});
