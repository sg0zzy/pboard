#!/bin/bash
# Certbot deploy hook for this experimental relay only. Run on the VPS as root;
# private certificate material must never leave the server or enter application logs.
set -euo pipefail
umask 077
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/pboard.cecosl.ovh) ;;
  *) exit 0 ;;
esac
destination=/etc/haproxy/certs/pboard-signaling.pem
work=$(mktemp -d /etc/haproxy/certs/.pboard-renew.XXXXXX)
trap 'rm -rf "$work"' EXIT
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -checkend 0 -noout >/dev/null
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -checkhost pboard.cecosl.ovh -noout >/dev/null
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -pubkey -noout |
  openssl pkey -pubin -outform DER > "$work/cert-public.der"
openssl pkey -in "$RENEWED_LINEAGE/privkey.pem" -pubout -outform DER > "$work/key-public.der"
cmp -s "$work/cert-public.der" "$work/key-public.der"
cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" > "$work/bundle.pem"
if test -e "$destination"; then
  cp -p "$destination" "$work/previous.pem"
fi
mv "$work/bundle.pem" "$destination"
if ! /usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null || ! systemctl reload haproxy; then
  if test -e "$work/previous.pem"; then
    mv "$work/previous.pem" "$destination"
  else
    rm -f "$destination"
  fi
  echo 'Pboard certificate deployment failed; restored previous bundle.' >&2
  exit 1
fi
