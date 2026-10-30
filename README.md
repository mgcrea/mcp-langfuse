# @mgcrea/mcp-langfuse

A [Model Context Protocol](https://modelcontextprotocol.io) server for
**[Langfuse](https://langfuse.com)**, built for **Langfuse v4 deployments in events-only
mode**: traces, sessions, observations, scores, metrics and prompts.

It is **read-only**. The only path that can mutate anything is the `langfuse_request` escape
hatch, and it is GET-only unless `LANGFUSE_ALLOW_WRITES=1`.

## Why another Langfuse MCP

Two failures with the existing Python `langfuse-mcp` prompted this one.

1. **Events-only mode.** Langfuse v4 can run in an "events only" mode where `GET /traces`,
   `/traces/{id}`, `/sessions`, `/observations` (v1) and `/scores` (v1 and v2) all answer
   `404 — not available on deployments running in Langfuse v4 events_only mode`. Every
   older client is built on those endpoints. This server reads only what survives:
   `/v2/observations`, `/v2/metrics`, `/v3/scores` and `/v2/prompts`. It rebuilds a trace from
   its observations and a session from its traces.
2. **The wrong project, silently.** Langfuse keys are project-scoped, so the key alone
   decides which project answers. A key copied from the wrong project answers every query
   with plausible data from that project. This server checks every key against the project
   it is filed under before reading anything, names the project in its startup log and in
   `langfuse_auth_status`, and stamps `project` on every data response.

One server reads **many projects**: it holds one key per project, and every data tool takes
a `project` argument. On an OSS Langfuse there is no API that mints those keys (it is the EE
`admin-api`), so `pnpm provision` writes them into Langfuse's own Postgres — see
[Provisioning keys](#provisioning-keys).

## Features

- Traces as a **depth-first tree** with total token usage, cost, `ERROR` steps, and the
  trace's input/output. That input/output comes from the first observation that has one,
  because the root span is often an AGENT that carries none.
- **Sessions** as their traces in chronological order, each with its input and output.
- **Observation search** by type, level, model, name, latency, metadata (raw filters) and
  indexed literal text search over input/output. `level: "ERROR"` is how to find failed runs.
- **Server-side aggregates** through `/v2/metrics`: counts, cost, token sums and latency
  percentiles, grouped and bucketed over time.
- Output is shaped for the context window. Empty fields and per-row pricing echoes are
  dropped, and so are the OpenTelemetry `scope.*` / `resourceAttributes.*` metadata keys that
  every span repeats (one of them is the project's public key). LLM inputs, often 20 KB each,
  are cut to a budget you choose, with an honest `[truncated: N chars total]` marker.
- **Relative time windows** (`since: "24h"`, `"7d"`), because a model rarely knows today's
  date.
- Native `fetch`, no runtime dependencies beyond the MCP SDK and Zod.

## Configure

Keys come from three places, merged by project name, earlier wins:

1. `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`, filed under `LANGFUSE_PROJECT`.
2. `LANGFUSE_PROJECTS`, a JSON map: `{"sales": {"publicKey": "pk-lf-…", "secretKey": "sk-lf-…", "id": "…"}}`.
3. The keys file, `~/.config/langfuse-mcp/keys.json` — what `pnpm provision` writes.

| Variable                | Description                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `LANGFUSE_HOST`         | Instance URL, e.g. `https://langfuse.example.com`. Else the keys file's `host`, else Langfuse Cloud. |
| `LANGFUSE_KEYS_FILE`    | Keys file path. Defaults to `$XDG_CONFIG_HOME/langfuse-mcp/keys.json`.                               |
| `LANGFUSE_PROJECTS`     | JSON map of project name → key pair, as above.                                                       |
| `LANGFUSE_PUBLIC_KEY`   | `pk-lf-…`, a single project's key, from Project Settings → API Keys.                                 |
| `LANGFUSE_SECRET_KEY`   | `sk-lf-…`, the matching secret.                                                                      |
| `LANGFUSE_PROJECT`      | The name (or id) that single key is filed under, and checked against.                                |
| `LANGFUSE_ALLOW_WRITES` | `1` lets `langfuse_request` send POST/PUT/PATCH/DELETE.                                              |
| `LANGFUSE_MAX_RETRIES`  | Retry budget for 429/5xx. Defaults to 3.                                                             |
| `LANGFUSE_DEBUG`        | `1` logs each request to stderr.                                                                     |

`LANGFUSE_BASE_URL` is accepted as an alias of `LANGFUSE_HOST`, and the names match the
Langfuse SDKs and the Python `langfuse-mcp`, so an existing single-project `.mcp.json` entry
switches over by changing its `command`.

**The project check.** Every key in `LANGFUSE_PROJECTS` or the keys file must resolve to the
project it is filed under — by name ignoring case, or by its recorded `id` — or every call to
that project is refused before anything is read. A lone `LANGFUSE_PUBLIC_KEY` pair without
`LANGFUSE_PROJECT` is served unchecked as `default`, as before; alongside other projects it
is ignored until `LANGFUSE_PROJECT` names it.

**One project or several.** With one project configured, `project` may be omitted. With
several it is required on every data tool, with no default — a silently chosen project is
the failure this server exists to prevent.

With no keys at all the server still starts and serves `langfuse_auth_status`, which says
what to set. It does not exit, because a server that exits shows up in the client only as
`Connection closed`. A malformed keys file is reported the same way.

## Provisioning keys

Langfuse keys are project-scoped, and the API that mints them —
`POST /api/public/projects/{id}/apiKeys` — needs an organization key **and** the EE
`admin-api` entitlement (self-hosted Enterprise, or Cloud Team/Enterprise). On an OSS
instance every organization endpoint answers 403 "not available on your current plan". The
data plane is fully OSS, so a key written straight into Langfuse's Postgres, exactly as its
own UI writes it, authenticates like any other. That is what `pnpm provision` does:

```bash
kubectl port-forward -n langfuse svc/langfuse-postgresql 15432:5432 &
LANGFUSE_HOST=https://langfuse.example.com \
LANGFUSE_DB_URL=postgres://langfuse:…@127.0.0.1:15432/langfuse \
LANGFUSE_SALT=… \
pnpm provision            # dry run: prints the plan, changes nothing
pnpm provision --apply    # mint, verify, save
```

- **`LANGFUSE_SALT` must be the `SALT` of the running `langfuse-web`.** Read it from the
  deployment, not a local copy of the secrets, which can be stale. A wrong salt — or the
  wrong database — still inserts a row whose key never authenticates.
- **Every minted key is verified** against `GET /api/public/projects` after its row commits,
  and must resolve to the right project. A key that fails is deleted again and the run stops.
- **Safe to re-run.** A recorded key that still works is kept. One that returns 401 is
  replaced, and only then revoked. One that reads a different project is replaced but left
  in place, since something else may use it. New projects get keys; entries for deleted
  projects leave the file (no row is touched).
- The file is written after **each** key, mode `0600`, so a crash never leaves a key in
  Langfuse whose secret exists nowhere.
- `--only a,b` / `--exclude a,b` (names or ids) limit a run.
- Keys carry the note `mcp-langfuse (read)` in Langfuse's UI. Langfuse has no read-only key
  type: they can ingest too.
- **Coupling.** This reproduces Langfuse's internal `api_keys` storage scheme, verified on
  4.63.0. The script probes the columns it needs and stops if they moved; re-check
  `src/provision/keys.ts` on a Langfuse upgrade.

`pg` and `bcryptjs` are dev dependencies used only by the script. The published server
keeps its two runtime dependencies.

## Tools

Every data tool takes `project`: one of the configured names.

| Tool                         | What it does                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `langfuse_auth_status`       | Every configured project and what its key resolves to; version, events-only mode |
| `langfuse_list_traces`       | Traces newest first (root observations), filtered by name/user/session/tags/time |
| `langfuse_get_trace`         | One trace as a tree, with usage, cost, errors and input/output                   |
| `langfuse_get_session`       | A session's traces in order, each with its input/output                          |
| `langfuse_list_observations` | Search observations: type, level, model, latency, text in input/output, metadata |
| `langfuse_get_observation`   | One observation in full; `savePath` writes it uncut to disk                      |
| `langfuse_list_scores`       | Scores via `/v3/scores`, with what each is attached to                           |
| `langfuse_query_metrics`     | Aggregates via `/v2/metrics`: count, cost, tokens, latency percentiles           |
| `langfuse_list_prompts`      | Managed prompts, versions and labels                                             |
| `langfuse_get_prompt`        | One prompt version in full                                                       |
| `langfuse_request`           | Raw `/api/public/*` call, unshaped; GET-only unless writes are enabled           |

## Traps worth knowing

- **Units differ.** Observation rows report `latency` in **seconds**, but `/v2/metrics`
  reports `latency` and `timeToFirstToken` in **milliseconds**.
- **`filter` silently overrides plain query params** on `/v2/observations`. This server
  always sends the JSON `filter` and never the plain params. Keep that in mind if you call
  the endpoint through `langfuse_request`.
- **A failed trace's root is usually still `DEFAULT`.** Find failures with
  `langfuse_list_observations` and `level: "ERROR"`, not by listing traces.
- **App roots.** An SDK-marked root can carry a `parentObservationId` that points outside
  the trace. The tree treats it as a root.
- **Observation ids are scoped to a trace.** Pass `traceId` to `langfuse_get_observation`
  whenever you have it.
- **High-cardinality fields** (`traceId`, `userId`, `sessionId`, `id`) cannot be metric
  dimensions. Filter on them instead.

## Quick start

```bash
pnpm install
pnpm build
```

Then copy `.mcp.json.example` to `.mcp.json` and fill it in.

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest, offline: fetch is mocked
pnpm typecheck
pnpm lint
pnpm format
```

To check against a real instance, start the built server with real keys, then call
`langfuse_auth_status` first. It confirms the host, the project and events-only mode before
you read any data.

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
