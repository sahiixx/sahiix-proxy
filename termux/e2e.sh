#!/data/data/com.termux/files/usr/bin/bash
# Sahiix Proxy E2E runner — bash + curl + python3 only (no Jest needed).
# Spins up a local echo origin + the built proxy (dist/) on loopback and
# exercises auth, rate limits, governance, WATI webhook, admin API, CORS,
# proxy headers and error paths.
#
# Usage:
#   bash termux/e2e.sh
#   API_BASE=https://proxy.sahiix.com AUTH_SECRET=your-secret bash termux/e2e.sh  # live
set -u

PROXY_DIR="${PROXY_DIR:-$HOME/sahiix-proxy}"
SECRET="${AUTH_SECRET:-e2e-bash-secret-32-chars-minimum!}"
ADMIN_PHONE="+971500000001"
LIVE_BASE="${API_BASE:-}"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1 (got: $2)"; }
expect_eq() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected[$2] actual[$3]"; fi
}
expect_contains() { # name needle haystack
  if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1" "missing[$2] in [$3]"; fi
}

mint() { # sub [tier] [role] -> jwt (HS256, python3 stdlib)
  python3 - "$1" "${2:-free}" "${3:-user}" "$SECRET" <<'EOF'
import base64, hashlib, hmac, json, sys, time
sub, tier, role, secret = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
h = b64(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
p = b64(json.dumps({"sub":sub,"tier":tier,"role":role,"exp":int(time.time())+3600}).encode())
s = b64(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{s}")
EOF
}

BODY_FILE=""
HDR_FILE=""
REQ() { # METHOD path [token] [data] -> sets HTTP_CODE, BODY_FILE, HDR_FILE
  local method="$1" path="$2" tok="${3:-}" data="${4:-}"
  BODY_FILE="$(mktemp)"; HDR_FILE="$(mktemp)"
  local args=(-s -o "$BODY_FILE" -D "$HDR_FILE" -w "%{http_code}" -X "$method")
  [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  HTTP_CODE=$(curl "${args[@]}" "$BASE$path")
}

HDR() { grep -i "^$1:" "$HDR_FILE" | head -n1 | cut -d' ' -f2- | tr -d '\r' || true; }

wait_for() { # url tries
  local i=0
  while [ $i -lt "$1" ]; do
    curl -s -o /dev/null "$2" 2>/dev/null && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

if [ -n "$LIVE_BASE" ]; then
  BASE="$LIVE_BASE"
  echo "▶ E2E against live deployment: $BASE"
else
  BASE="http://127.0.0.1:18788"
  ECHO_PORT=18787
  TMP="$(mktemp -d)"
  echo "▶ Starting echo origin :$ECHO_PORT and proxy :18788 ..."
  node "$PROXY_DIR/tests/echo-origin.js" "$ECHO_PORT" >"$TMP/echo.log" 2>&1 &
  ECHO_PID=$!
  SAHIIX_API_BASE="http://127.0.0.1:$ECHO_PORT" AUTH_SECRET="$SECRET" \
    RATE_LIMIT_KV_PATH="$TMP/rate" GOVERNANCE_KV_PATH="$TMP/gov" \
    ADMIN_NUMBERS="$ADMIN_PHONE" PORT=18788 \
    node "$PROXY_DIR/dist/index.js" >"$TMP/proxy.log" 2>&1 &
  PROXY_PID=$!
  trap 'kill $ECHO_PID $PROXY_PID 2>/dev/null; rm -rf "$TMP" "$BODY_FILE" "$HDR_FILE" 2>/dev/null' EXIT
  wait_for 30 "http://127.0.0.1:$ECHO_PORT/nope" || { echo "echo origin failed to start"; cat "$TMP/echo.log"; exit 1; }
  wait_for 30 "$BASE/health" || { echo "proxy failed to start"; cat "$TMP/proxy.log"; exit 1; }
  echo "▶ Both up. Running assertions..."
fi

U_FREE="$(mint e2e-bash-free)"
U_PRO="$(mint e2e-bash-pro pro)"
U_ADMIN="$(mint e2e-bash-admin enterprise admin)"

echo "== authentication =="
REQ POST /proxy "" '{"a":1}';               expect_eq "missing auth -> 401" 401 "$HTTP_CODE"
REQ POST /proxy "" '{"a":1}';               expect_eq "malformed (empty) -> 401" 401 "$HTTP_CODE"  # no header at all
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer" -H "Content-Type: application/json" -d '{}' "$BASE/proxy")
expect_eq "malformed Bearer -> 401" 401 "$HTTP_CODE"
REQ POST /proxy "$U_FREE" '{"hello":"world"}'
expect_eq "valid JWT -> 200" 200 "$HTTP_CODE"
expect_contains "origin sees user" "e2e-bash-free" "$(cat "$BODY_FILE")"

echo "== rate limiting =="
U_RL="$(mint e2e-bash-rl)"
for _ in $(seq 1 20); do REQ POST /proxy "$U_RL" '{}' >/dev/null 2>&1; done
REQ POST /proxy "$U_RL" '{}'
expect_eq "21st request -> 429" 429 "$HTTP_CODE"
[ -n "$(HDR Retry-After)" ] && ok "Retry-After present" || bad "Retry-After present" "empty"
expect_eq "X-RateLimit-Remaining 0" 0 "$(HDR X-RateLimit-Remaining)"

echo "== governance =="
REQ POST /admin/governance/rules "$U_ADMIN" '{"userId":"e2e-bash-blocked"}'
expect_eq "admin creates rule -> 201" 201 "$HTTP_CODE"
REQ POST /proxy "$(mint e2e-bash-blocked)" '{}'
expect_eq "blocked user -> 403" 403 "$HTTP_CODE"
REQ POST /proxy "$U_ADMIN" '{}'
expect_eq "admin bypass -> 200" 200 "$HTTP_CODE"
REQ POST /admin/governance/rules "$U_ADMIN" '{"path":"/v1/admin/*"}'
expect_eq "path rule created" 201 "$HTTP_CODE"
REQ POST /v1/admin/stats "$U_FREE" '{}'
expect_eq "path rule blocks free" 403 "$HTTP_CODE"

echo "== wati webhook =="
REQ POST /wati/webhook "" "{\"from\":\"$ADMIN_PHONE\",\"text\":\"/status\"}"
expect_eq "/status -> 200" 200 "$HTTP_CODE"
REQ POST /wati/webhook "" "{\"from\":\"$ADMIN_PHONE\",\"text\":\"/rule list\"}"
expect_eq "/rule list -> 200" 200 "$HTTP_CODE"
expect_contains "rule count present" "count" "$(cat "$BODY_FILE")"
REQ POST /wati/webhook "" "{\"from\":\"$ADMIN_PHONE\",\"text\":\"/block e2e-bash-wati\"}"
expect_eq "/block -> 200" 200 "$HTTP_CODE"
REQ POST /proxy "$(mint e2e-bash-wati)" '{}'
expect_eq "wati-blocked user -> 403" 403 "$HTTP_CODE"
REQ POST /wati/webhook "" '{"from":"+971599999999","text":"/block e2e-bash-spared"}'
expect_contains "non-admin ignored" "true" "$(cat "$BODY_FILE")"
REQ POST /proxy "$(mint e2e-bash-spared)" '{}'
expect_eq "spared user still 200" 200 "$HTTP_CODE"

echo "== admin api =="
REQ GET /admin/governance/rules "$U_ADMIN";  expect_eq "admin GET 200" 200 "$HTTP_CODE"
REQ GET /admin/governance/rules "$U_FREE";   expect_eq "user GET 403" 403 "$HTTP_CODE"
REQ GET /admin/governance/rules;              expect_eq "anon GET 401" 401 "$HTTP_CODE"

echo "== cors =="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE/proxy")
expect_eq "preflight -> 204" 204 "$HTTP_CODE"
REQ POST /proxy "$U_PRO" '{}'
[ "$(HDR Access-Control-Allow-Origin)" = "*" ] && ok "ACAO on response" || bad "ACAO on response" "$(HDR Access-Control-Allow-Origin)"

echo "== proxy headers =="
REQ POST /proxy "$U_PRO" '{}'
expect_contains "X-Proxy-Tier=pro at origin" "pro" "$(cat "$BODY_FILE")"
RID="$(HDR X-Request-ID)"
[ -n "$RID" ] && ok "X-Request-ID returned" || bad "X-Request-ID returned" "empty"

echo "== errors =="
REQ GET /nope;                    expect_eq "unknown -> 404" 404 "$HTTP_CODE"
REQ POST /boom "$U_PRO" '{}';     expect_eq "upstream 502 passthrough" 502 "$HTTP_CODE"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: text/plain" -d '{not json' "$BASE/wati/webhook")
expect_eq "invalid JSON -> 400" 400 "$HTTP_CODE"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
