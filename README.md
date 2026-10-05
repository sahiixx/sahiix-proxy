# Sahiix Edge Proxy

A TypeScript HTTP gateway for Node.js, with deployment tooling for Android's
Termux. The runtime uses only Node's standard library: it authenticates proxy
requests, applies per-user rate limits and block rules, and forwards POSTs to a
configured upstream. It also exposes a health endpoint, an admin rules API, and
an inbound WATI command webhook.

As [STATUS.md](STATUS.md) specifies, this is an **adapter**. Business state
belongs upstream in FirstCall or sahiixx-bus; the local files here hold only
operational rate counters and governance rules. “Edge” describes its gateway
role, not compatibility with an isolate-based edge-worker runtime.

## Prerequisites and installation

- **Node.js 20 or newer** and npm, as declared in `package.json`. GitHub Actions
  uses Node.js 20; the local build and Jest verification for this README used
  Node.js 24.21.0 and npm 12.2.0.
- Include development dependencies to build TypeScript or run Jest. There are
  no production npm dependencies.
- Writable local directories for rate-limit counters and governance rules.
- The alternative shell E2E runner needs Bash, curl, and Python 3. The Termux
  deployment scripts use Bash, Git, and PM2; the installer uses Termux's `pkg`
  package manager when tools are missing.

From the repository root:

```sh
npm ci --ignore-scripts
npm run build
```

The lockfile is checked in. `build` runs `tsc`, compiling `src/index.ts` to
CommonJS in `dist/index.js`; it does not migrate a database or start a service.

## Configuration

Provide these names through the process environment or a local, untracked
`.env` file. No credential values are included here. On startup, the built
application reads the first available `.env` in the current working directory
or repository root; variables already in the process environment win. The
loader supports plain assignments, comments, and matching single/double quotes,
not shell expansion or a full dotenv specification. There is no checked-in
`.env.example`.

| Variable             | Use                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | HTTP listening port.                                                                                                                          |
| `SAHIIX_API_BASE`    | Upstream base URL. For local work, select a disposable loopback origin explicitly; the unset default points to a remote API.                  |
| `AUTH_SECRET`        | Shared secret for HS256 JWT verification; also forwarded upstream as the bearer credential. Without it, authenticated routes reject requests. |
| `RATE_LIMIT_KV_PATH` | Writable directory for per-user, per-minute counter files.                                                                                    |
| `GOVERNANCE_KV_PATH` | Writable directory containing `rules.json`.                                                                                                   |
| `ADMIN_NUMBERS`      | Comma-separated sender allowlist for inbound WATI admin commands; absent means no permitted senders.                                          |

The two KV paths default to directories under the current user's
`~/.sahiix-proxy/kv/`. Use disposable paths for development so tests or manual
commands cannot alter operational rules or counters.

## Run locally without a live upstream

1. Start the included local echo origin in one terminal:

   ```sh
   node tests/echo-origin.js
   ```

   It listens on `127.0.0.1:18787` and echoes request bodies and proxy metadata.

2. In a separate development shell, configure `SAHIIX_API_BASE` to point to that
   loopback origin, choose a development-only `AUTH_SECRET`, and point both KV
   variables at disposable directories. Leave `ADMIN_NUMBERS` absent unless
   exercising the webhook with local test senders. Then run:

   ```sh
   npm start
   ```

3. With the default listening port, check the proxy itself:

   ```sh
   curl --fail http://127.0.0.1:8787/health
   ```

`start` runs the already-built `dist/index.js`; there is no development/watch
script. Rebuild after editing TypeScript. Stop both foreground processes with
Ctrl+C. The CLI does not specify a host when listening, so it can accept
connections on non-loopback interfaces, even when the upstream is local.

The public health response only checks this process; it does not probe upstream
availability, validate credentials, or prove the KV directories are writable.

## HTTP behavior

| Route                          | Behavior                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                  | Public JSON with `ok`, version, and process uptime.                                                                                                                                                 |
| `OPTIONS` on any path          | CORS preflight response.                                                                                                                                                                            |
| `POST /wati/webhook`           | Accepts JSON with `from` and `text` (also accepts `body` or `message` as the text field). Recognizes `/status`, `/rule list`, and `/block <userId>` for allowed senders; other senders are ignored. |
| `GET /admin/governance/rules`  | Lists rules for a JWT with the admin role.                                                                                                                                                          |
| `POST /admin/governance/rules` | Adds a block rule for an admin JWT. Requires a `userId`, path pattern, or valid conditions.                                                                                                         |
| `POST` on other paths          | Authenticates, rate-limits, checks governance, and forwards the body, path, and query to the upstream.                                                                                              |
| Other requests                 | JSON 404 response; GET/PUT/DELETE are not general proxy methods.                                                                                                                                    |

Clients authenticate with `Authorization: Bearer <JWT>`. Tokens use HS256 and a
nonempty `sub` claim. The `tier` selects `free`, `standard`, `pro`, or
`enterprise`; unrecognized tiers become free. The `role` selects admin behavior.
A numeric expired `exp` is rejected, but the verifier does not require an
expiration claim. Token issuance/login is outside this adapter; the exported
`signJwt` helper is used by tests.

Per-user limits are 20, 100, 500, and 5,000 requests per calendar minute for
those four tiers. Exhaustion returns 429 with `Retry-After` and rate headers.
Governance matches optional user IDs, exact paths or trailing `/*` patterns,
and AND-ed conditions on path, user ID, or tier using `equals`/`startsWith`.
Admin users bypass governance blocks, but still consume rate limits.

The upstream receives `X-Proxy-User`, `X-Proxy-Tier`, `X-Request-ID`, and the
server's shared bearer secret rather than the original client JWT. The response
preserves the upstream status, body text, and content type, with proxy/request
and rate headers added. Connection failures and proxy timeouts return 502;
upstream HTTP error statuses are passed through.

The application handles WATI commands as inbound HTTP requests and returns
JSON. It does not itself send WhatsApp replies or require a WATI API credential.

## Verification

```sh
npm run build
npm test
bash -n termux/install.sh
bash -n termux/sync-daemon.sh
bash -n termux/e2e.sh
bash -n termux/proxy.service
```

`npm test` runs all three Jest suites sequentially. Unit tests cover JWTs,
rate limits, governance, command parsing, and dotenv loading. E2E tests create
both proxy and fake upstream on ephemeral loopback ports, with test-only
credentials and temporary KV files. They exercise auth, limits, governance,
webhooks, CORS, headers, and errors without a live provider. All 39 tests and the
TypeScript build passed during README verification.

For focused runs, `npm run test:unit` selects unit/dotenv tests and
`npm run test:e2e` selects the loopback HTTP suite. CI runs these two scripts
after building. Its step labeled “shellcheck” actually uses `bash -n` for syntax
checking, not the ShellCheck tool. There are no lint or separate typecheck npm
scripts; the build performs TypeScript checking.

The alternative `termux:e2e` script builds and runs `termux/e2e.sh`. To select
its local mode from any clone on a POSIX shell:

```sh
env -u API_BASE -u AUTH_SECRET PROXY_DIR="$PWD" npm run termux:e2e
```

The runner normally assumes a clone at `~/sahiix-proxy`, uses fixed ports 18787
and 18788, and creates temporary KV files. `PROXY_DIR` overrides that location.
**Setting `API_BASE` switches it to a live target:** the assertions then create
governance rules and consume rate limits there. Use the local mode for routine
verification. Jest and shell syntax were checked here; the shell E2E runner and
an Android/Termux installation were not exercised.

## Deployment tooling and limitations

The runtime needs a long-lived Node process and writable, persistent storage.
It is not directly deployable as a Cloudflare Worker or a stateless serverless
function. The HTTP listener has no built-in TLS termination. PM2's checked-in
`ecosystem.config.js` uses one forked instance, and the runtime's own dotenv
loader supplies configuration: `env_file` is not a supported PM2 option.

Rate counters and `rules.json` use synchronous, uncoordinated file operations.
They are not a distributed KV implementation and are unsuitable for concurrent
instances sharing the same files without additional coordination. Rate limiting
fails open on filesystem errors, and unreadable/invalid rule files load as an
empty rules list. Old counter files have no automatic cleanup. Request bodies
are capped at 1 MiB; upstream responses are buffered as text, not streamed as
SSE or tunneled as WebSockets. The forwarding timeout is ten seconds.

The WATI endpoint checks only the sender string supplied in the request against
`ADMIN_NUMBERS`; it has no JWT requirement or webhook signature verification.
Public exposure therefore requires an independently authenticated ingress.
CORS uses a wildcard origin and is not an access-control boundary.

Termux files are operational tooling, not needed for the local build/test flow:

- `termux/install.sh` targets `~/sahiix-proxy`, clones or pulls the repository,
  installs missing Node/Git/PM2 tools, installs dependencies, builds, writes an
  environment template and PM2 configuration, and copies the sync daemon. It
  adds a Termux:Boot hook only if the boot directory already exists. Review the
  bundled environment settings before use; the installer prints manual start
  steps rather than starting the proxy immediately.
- `termux/proxy.service` is a Termux runit-style launcher, not a systemd unit.
  It assumes the same clone location and an existing compiled `dist/index.js`.
- `termux/sync-daemon.sh` periodically fetches/pulls, reinstalls, rebuilds, and
  restarts PM2 when it finds a different commit. It can also send outbound WATI
  notifications; running it changes the deployed service.

Tooling-only environment names:

| Variable                                         | Use                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GH_TOKEN`                                       | Optional GitHub credential consumed by the installer.                                                                        |
| `PROXY_DIR`                                      | Clone location for the sync daemon and shell E2E runner.                                                                     |
| `BRANCH`, `CHECK_INTERVAL`                       | Branch and polling interval for the sync daemon.                                                                             |
| `REPO_URL`                                       | Declared by the sync daemon, but fetch/pull actually use the clone's existing `origin`.                                      |
| `WATI_API_KEY`, `WATI_BASE_URL`, `ADMIN_NUMBERS` | Optional outbound notification settings for the sync daemon. It reads exported shell variables, not the app's dotenv loader. |
| `API_BASE`, `AUTH_SECRET`                        | Live-target selection and JWT signing credential for the shell E2E runner; avoid live mode for ordinary checks.              |
| `PREFIX`, `LD_PRELOAD`                           | Termux compatibility detection in the installer.                                                                             |

## Source map

- `src/index.ts`: configuration/dotenv loading, JWTs, file-backed limits and
  rules, WATI parsing, HTTP routing, and the executable entry point.
- `tests/`: Jest unit/E2E tests and the standalone echo origin.
- `termux/`: installer, runit launcher, sync daemon, and Bash E2E runner.
- `ecosystem.config.js`: PM2 process definition.
- `.github/workflows/ci.yml`: Node.js build, Jest, and shell syntax checks.
