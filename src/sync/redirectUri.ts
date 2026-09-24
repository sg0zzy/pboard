/**
 * Derives the Firefox loopback redirect URL from the URL returned by
 * `identity.getRedirectURL()`.
 *
 * Firefox 86+ extracts the OAuth result from the redirect URL without loading
 * any local response, so a local HTML redirect page is NOT needed. The loopback
 * subdomain must match the single-label hash subdomain that
 * `getRedirectURL()` returns (e.g. `https://3347c8…extensions.allizom.org/`),
 * which is always a dot-free 32-char hex hash of the extension ID — for both
 * temporary (UUID) and signed (dotted-ID) installs. Taking the first hostname
 * label therefore yields the correct subdomain in every case.
 */
export function toFirefoxLoopbackRedirect(generated: string): string {
  const subdomain = new URL(generated).hostname.split(".")[0];
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}
