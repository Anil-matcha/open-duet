# Self-hosting walkthrough runbook (S′)

Operator-facing, top-to-bottom executable in a dedicated scratch dir. Every
transcript is captured **through the redaction filter** — never raw, never with
`set -x`. Read alongside `docs/SELF-HOSTING.md` (the claim set under test) and the
spec `.agents/specs/self-hosting-dependability/spec.md`.

> Host identity in public artifacts: **"a private Linux host (non-root, no systemd,
> private IP)"**. The platform name stays in the internal record only.

## 0 — Fixed choices (settled 2026-10-25)

| Item | Value | Why |
| --- | --- | --- |
| Engine | `openai_compat` via `api.river.ai/v1`, model `deepseek-ai/DeepSeek-V4.1-Flash` | operator's configured default; live probe HTTP 200 |
| Key source | opencode/qwen CLI env (river/opencode free-model credits) | operator-provided at run time |
| ~~opencode zen~~ | **REJECTED** | 403s across its API surface (/v1/models authed+unauthed, chat with code-supernova ids) |
| Scratch root | `/tmp/sprime-walkthrough` | keeps the operator's real drives untouched (AC 11) |
| Stop rule | **6 hours on this host, or all criteria met — whichever first** (AC 8) | no overtime, no silent expansion |

## 1 — Preconditions (do first)

```bash
# Scratch root, world-readable only by the owner. Everything lives here.
export SPRIME=/tmp/sprime-walkthrough
install -d -m 700 "$SPRIME"
cd "$SPRIME"

# Register the passphrase WITHOUT echoing it and WITHOUT putting it in history.
# read -s keeps it off the screen; it is passed to the filter via the environment
# of this shell only, never written to a file by hand.
printf 'Sign-in passphrase> '; read -rs SPRIME_PASSPHRASE; echo
export SPRIME_PASSPHRASE

# Capture helper: every command below is run through this so nothing lands raw.
# (No `set -x` anywhere in this runbook, by AC 3.)
sprun() { "$@" 2>&1 | python3 "$SPRIME/clone/scripts/self-host/redact.py"; }
```

## 2 — Clone and install (direct-install route)

```bash
# Direct install per docs/SELF-HOSTING.md §"Route 2: direct install".
git clone <fork-url> "$SPRIME/clone"
cd "$SPRIME/clone"

# Record the runbook invocation itself, redacted, as the transcript header.
sprun printf 'SELF-HOSTING WALKTHROUGH — started %s\n' "$(date -u +%FT%TZ)"
sprun git rev-parse HEAD

# uv + node runtime; env file 600. The key is piped in, never echoed.
sprun bash -c 'cd backend && uv sync --frozen'
sprun bash -c 'cd frontend && npm ci'
sprun bash -c 'node scripts/build-ui.js'
```

## 3 — Server env file (mode 600) and first start

```bash
# Write the env file with the key from the caller's environment (no echo).
umask 077
cat > "$SPRIME/open-dots.env" <<EOF
OPENAI_BASE_URL=https://api.river.ai/v1
OPENAI_API_KEY=$SPRIME_RIVER_KEY
LOCAL_EXECUTION_ENABLED=true
OPEN_DOTS_PUBLIC_URL=http://127.0.0.1:8000
EOF
chmod 600 "$SPRIME/open-dots.env"

# Start on this host's loopback only.
sprun bash -c 'cd backend && env $(cat '"$SPRIME"'/open-dots.env | xargs) uv run python -m app.dev'
```

## 4 — Walkthrough steps (AC 2)

Save each as a redacted transcript under `$SPRIME/artifacts/`:

1. `install.txt` — the §2 commands and their output.
2. `serve.txt` — server start + the health line.
3. `signin.txt` — sign-in through the filter (the known leak venue: passphrase +
   `eyJ…` session cookie).
4. `conversation.txt` — a real turn against the river engine, including one
   approval stop.
5. `approval.txt` — the approval decision flow.
6. `computer-drive.txt` — the cloud-computer drive inside a turn (AC 5).
7. `sigterm-restart.txt` — `kill -TERM <pid>`, restart, then a probe proving state
   survived (AC 2).

## 5 — Gateway-semantics row (AC 1) and its control (AC 4)

```bash
# No nginx/caddy here: a loopback-hop forwarder stands in, LABELED as a simulation.
# It emulates host substitution + the X-Forwarded-For field. It does NOT emulate
# multi-hop X-Forwarded-For chains, TLS termination, connection upgrades, or real
# proxy-trust semantics. Record that fidelity statement verbatim in the table row.
sprun python3 scripts/self-host/probe_gateway.py --mode hop

# AC 4 control: with TRUSTED_PROXIES unset/wrong, the check must FAIL.
sprun python3 scripts/self-host/probe_gateway.py --mode hop --unset-trusted
# A pass here (check still "ok" with the address unset) is a row with no teeth —
# record the failure in negative-control.md, do not paper over it.
```

## 6 — Post-run: capture hygiene, host state, stop line

```bash
# AC 3 end contract: grep every artifact for all four shapes + the literal
# passphrase. This must print nothing.
sprun python3 scripts/self-host/verify_no_secrets.py "$SPRIME/artifacts"

# AC 11: the run lived entirely under the scratch root.
sprun find "$SPRIME" -maxdepth 2 -type d

# AC 8: stamp wall-clock vs criteria state.
sprun printf 'stopped at %s\n' "$(date -u +%FT%TZ)"
```

Record in the verification note (AC 9): install location (`$SPRIME`), whether the
clone + session DBs are removed or kept, the env-file path and mode, and the
key-hygiene verdict — **recommend rotating the river key with the provider after the
artifacts are captured**, since it touched a shared host.

## 7 — What NOT to do

- Never `set -x`. Never `echo` a key or passphrase. Never redirect raw output to a
  file before it has passed `redact.py`.
- Never leave the scratch clone's session DBs in place if the note says they were
  removed — the host-state section must match reality.
- Never run past the 6-hour box (AC 8): unmet rows become not-run-remaining with a
  reason.
- Never call the gateway hop a "cleared" row if a downstream claim depends on a
  non-emulated behavior (AC 1) — downgrade it to `simulated-labeled`.
