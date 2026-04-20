#!/usr/bin/env bash
#
# Generate a self-signed CA and server certificate for TLS between
# the gateway and daemon inference proxy.
#
# Usage:
#   ./scripts/generate-tls-certs.sh [output-dir] [extra-SANs...]
#
# Examples:
#   ./scripts/generate-tls-certs.sh                           # output to ./certs/
#   ./scripts/generate-tls-certs.sh /etc/xinity/certs         # custom output dir
#   ./scripts/generate-tls-certs.sh ./certs 10.0.0.5 myhost   # extra SANs
#
# Output files:
#   ca.pem            - CA certificate (give to gateway as XINITY_INFERENCE_CA)
#   ca-key.pem        - CA private key (keep secure, only needed for signing new certs)
#   server.pem        - Server certificate (daemon XINITY_TLS_CERT)
#   server-key.pem    - Server private key (daemon XINITY_TLS_KEY)

set -euo pipefail

OUT_DIR="${1:-./certs}"
shift || true

DAYS_CA=3650
DAYS_CERT=825

mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# Build SAN list: always include localhost + 127.0.0.1, plus any extra args
# ---------------------------------------------------------------------------
SAN="DNS:localhost,IP:127.0.0.1"
for arg in "$@"; do
  if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN="${SAN},IP:${arg}"
  else
    SAN="${SAN},DNS:${arg}"
  fi
done

echo "Generating TLS certificates in ${OUT_DIR}/"
echo "Server SANs: ${SAN}"

# ---------------------------------------------------------------------------
# 1. Certificate Authority
# ---------------------------------------------------------------------------
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -days "$DAYS_CA" -nodes \
  -keyout "$OUT_DIR/ca-key.pem" \
  -out "$OUT_DIR/ca.pem" \
  -subj "/CN=xinity-ca" \
  2>/dev/null
chmod 600 "$OUT_DIR/ca-key.pem"

echo "  CA certificate:  ${OUT_DIR}/ca.pem"

# ---------------------------------------------------------------------------
# 2. Server certificate (for the daemon)
# ---------------------------------------------------------------------------
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -nodes \
  -keyout "$OUT_DIR/server-key.pem" \
  -out "$OUT_DIR/server.csr" \
  -subj "/CN=xinity-daemon" \
  2>/dev/null

openssl x509 -req \
  -in "$OUT_DIR/server.csr" \
  -CA "$OUT_DIR/ca.pem" \
  -CAkey "$OUT_DIR/ca-key.pem" \
  -CAcreateserial \
  -days "$DAYS_CERT" \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth" "$SAN") \
  -out "$OUT_DIR/server.pem" \
  2>/dev/null

rm -f "$OUT_DIR/server.csr" "$OUT_DIR/ca.srl"
chmod 600 "$OUT_DIR/server-key.pem"
echo "  Server cert:     ${OUT_DIR}/server.pem"
echo "  Server key:      ${OUT_DIR}/server-key.pem"

echo ""
echo "Done. Configure your services:"
echo ""
echo "  Daemon:"
echo "    XINITY_TLS_CERT_FILE=${OUT_DIR}/server.pem"
echo "    XINITY_TLS_KEY_FILE=${OUT_DIR}/server-key.pem"
echo ""
echo "  Gateway (only needed for self-signed certs):"
echo "    XINITY_INFERENCE_CA_FILE=${OUT_DIR}/ca.pem"
