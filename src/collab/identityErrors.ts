import { parseStrictJson } from './security/canonical';

const reasons: Record<string, string> = {
  directory_capacity: 'The rendezvous invitation directory has reached its board limit.',
  pending_capacity: 'This board has reached its pending device request limit.',
  policy_conflict: 'The server rejected a conflicting or older board sharing policy.',
  invalid_policy: 'The server rejected the board sharing policy. Check the owner device clock and authorization.',
  board_not_available: 'This board invitation is no longer available. The original authority browser must republish it.',
  board_not_authorized: 'The signed invitation does not authorize this Google account for this board.',
  device_identity_conflict: 'This device request is bound to a different Google account.',
  challenge_invalid: 'The authentication challenge expired or was already used. Retry the operation.',
  google_token_missing: 'No Google credential was provided. Reconnect Google.',
  google_token_rejected: 'Google rejected the credential. Reconnect Google.',
  google_permission_denied: 'Google refused the identity verification request. Check the connected account permissions.',
  invalid_request: 'The server rejected the device enrollment proof.',
  invalid_signature: 'The server could not verify the signed identity or board authorization proof.',
  service_capacity: 'The service has reached its admission capacity. Retry later.',
  invalid_service_binding: 'The service rejected the session-bound device proof.',
  google_unavailable: 'The service could not verify the Google account. Retry when Google is reachable.',
  google_response_invalid: 'The service could not validate the Google identity response.',
  google_identity_missing: 'Google did not provide a usable account identity.',
  email_not_allowed: 'This Google account is not admitted by the service configuration.',
  service_admission_requires_device_proof: 'Service admission requires authenticated device proof.'
};

/** Only fixed protocol reason codes may become UI text, never arbitrary error
 * bodies, proxy HTML, echoed credentials, signatures or board contents. */
export class IdentityServiceError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, explanation: string) {
    super(`Google account collaboration unavailable (HTTP ${status}${code ? `; ${code}` : ''}). ${explanation}`);
  }
}

export async function identityRejection(response: Response, endpoint: 'identity' | 'grant' = 'identity'): Promise<Error> {
  let code: string | undefined;
  const reader = response.body?.getReader();
  try {
    if (reader) {
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 4096) break;
        chunks.push(value);
      }
      if (size <= 4096) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const body = parseStrictJson(new TextDecoder().decode(bytes), 4096) as { code?: unknown };
        if (body && typeof body.code === 'string' && Object.hasOwn(reasons, body.code)) code = body.code;
      }
    }
  } catch { /* A malformed proxy/error response does not explain the rejection. */ }
  finally { await reader?.cancel().catch(() => {}); }
  const explanation = code ? reasons[code]
    : response.status === 404 ? (endpoint === 'grant'
      ? 'The signed board authorization metadata is unavailable. The original authority browser must republish it.'
      : 'The identity enrollment endpoint is unavailable or disabled on this service.')
    : response.status === 429 ? 'The service rate limit was reached. Retry later.'
    : response.status === 403 ? 'The service rejected identity or board authorization; its response did not include a recognized reason code.'
    : 'The account collaboration service is unavailable. Retry later.';
  return new IdentityServiceError(response.status, code, explanation);
}
