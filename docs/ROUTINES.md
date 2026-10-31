# Routines

A routine runs a prompt on one of your **local agents** on a schedule, when a
webhook calls it, or when you press **Run now**. Each run is an ordinary
conversation of that agent: the agent's engine, model, instructions, workspace
and computer (if it has one) are used, through the same thread runtime and
approval gate as a chat you type yourself. Nothing here needs Boat.

The older Boat **schedules** (`/schedules`, Telegram `/schedule`) are unchanged
and keep running Boat sandboxes. Routines are the local counterpart.

## What a routine is

| Field | Meaning |
| --- | --- |
| `agent_id` | The agent that runs it. A deleted or archived agent fails the run and pauses the routine. |
| `name`, `prompt` | What it is called, and what the agent is told to do. |
| `schedule_kind`, `schedule_spec`, `timezone` | When it runs (below). |
| `paused` | A paused routine never starts on its own. Webhook calls to it are refused; Run now still works. |
| `run_limit_minutes` | 1 to 240 (default 30). Active time only: time spent waiting for your approval does not count. A run that reaches it is stopped and recorded as failed. |
| `approval_mode` | `ask` (default), `plan` or `accept_edits`. A routine run uses the **stricter** of this and the agent's own mode, so a routine can never loosen what its agent may do. |
| `approval_timeout_minutes` | 1 to 1440 (default 30). How long a run waits for your answer before the request is denied. |
| `catch_up_minutes` | 0 to 1440 (default 60). How late a missed occurrence may still run, on top of two minutes that always count as on time (below). |
| `retry_limit` | 0 to 3 (default 0, off). How many times a failed run is started again (see [Retries](#retries)). |
| `retry_delay_minutes` | 1 to 1440 (default 5). How long after a failure the next attempt starts. |
| webhook | Off until you enable it. The secret is shown once; only its SHA-256 hash is stored. |

## Schedule kinds

All times are evaluated in the routine's IANA `timezone` (for example
`Europe/Berlin`; default `UTC`). The finest resolution is one minute.

| Kind | `schedule_spec` | Example summary |
| --- | --- | --- |
| `cron` | `{"expression": "0 9 * * 1-5"}` | five fields: minute hour day-of-month month day-of-week (Sunday is 0). As in standard cron, when both day fields are restricted, either may match. |
| `weekdays` | `{"days": [1,2,3,4,5], "time": "09:00"}` | "Mon–Fri at 09:00". Days use Sunday = 0. |
| `interval` | `{"every_minutes": 90, "anchor": "2026-10-17T08:00:00Z"}` | "Every 90 minutes". Elapsed time from the anchor (default: when saved), 5 to 10080 minutes, unaffected by clock changes. |
| `once` | `{"at": "2026-10-18T09:00"}` | "Once on Sun 18 Oct 2026 09:00". A time without an offset is read in the routine's timezone. After it fires the routine has no next run. |
| `manual` | `{}` | Runs only by Run now or webhook. |

The editor shows a plain-language summary and the next three dates for any
draft (`POST /routines/preview`), computed by the same code the scheduler uses.

**Clock changes.** A wall-clock time that does not exist (a spring-forward gap)
runs at the same offset after the gap (02:30 becomes 03:30). A wall-clock time
that happens twice (the repeated hour in autumn) runs once, at its first
occurrence. Interval schedules count elapsed minutes and ignore both.

## How a run happens

The scheduler is a background job in the backend process (like the Boat
schedule poller), checking every `ROUTINE_POLL_SECONDS` (default 5).

1. **Due.** For each unpaused routine whose `next_run_at` has passed, the
   latest occurrence that is due is found. If it is no more than
   `catch_up_minutes` (plus two minutes of scheduling slack) late it is
   queued; otherwise a `missed` run is recorded for it. Earlier occurrences that were also missed (the app was not running)
   are recorded once, as one `missed` run that says how many. `next_run_at`
   then moves to the first occurrence after now: missed work is never
   replayed one by one.
2. **Skip if still running.** If the routine already has a run that is
   queued, running or waiting for input, the new occurrence is recorded as
   `skipped` instead of starting a second, overlapping copy.
3. **Start.** A queued run is first marked `running` and committed, then a new
   conversation of the agent is created and the prompt is sent as its first
   turn. The conversation is linked from the run.
4. **Follow.** While the turn runs, a pending approval on it moves the run to
   `needs_input` and sends one notification; an answer moves it back to
   `running`. When the turn ends the run becomes `completed` (turn succeeded)
   or `failed` (failed or stopped), with the error and the start of the result
   kept on the run.

Run states: `queued`, `running`, `needs_input`, `completed`, `failed`,
`missed`, `skipped`, `interrupted`.

### Retries

Off by default. With `retry_limit` above 0, a run that **failed** is queued
again as a new run (trigger `retry`, `attempt` one higher, `retry_of` naming
the failed run) that starts `retry_delay_minutes` after the failure, in a new
conversation, with the same prompt (webhook payload included) and a first
line telling the agent that an earlier attempt failed and may have done part
of the work. A routine with `retry_limit` 2 makes at most three attempts.

- Retried: the engine reported a failure; or the run could not start because
  the engine was not available, the agent's workspace was not usable, or an
  unexpected error happened while starting (possibly transient).
- Never retried: a completed run; a run stopped by a person or by its run
  limit; an `interrupted` run (see below: it may already have had side
  effects); a run that could not start for a reason that does not fix itself:
  its agent is gone, archived or unavailable (the routine may be paused), its
  engine is unknown, its model is not valid for the engine, or local
  execution is off.
- A waiting retry counts as the routine's active run: Run now answers 409
  until it starts. A scheduled occurrence that falls due meanwhile replaces it
  (the retry is recorded as `skipped`, the occurrence runs). Pausing the
  routine records a waiting retry as `skipped`.
- One retry per failed run: a unique index on `retry_of` refuses a second
  one, and starting a retry uses the same conditional `queued` → `running`
  claim as any run, so two schedulers cannot both queue or both start it.
- The failure notification says when the next attempt starts. A retry still
  queued at a restart follows the catch-up rule of an occurrence: if its start
  time is more than `catch_up_minutes` (plus two minutes) ago it is recorded
  as `missed` and never run; otherwise it starts normally. A retry that was
  running is `interrupted` like any run.

### Unattended approvals

A routine run uses the person’s saved permissions:

- The turn runs with the stricter of the routine's and the agent's approval
  mode. Every request the engine would ask about creates the usual approval
  card in that conversation, and the run parks in `needs_input` with an in-app
  notification (and Telegram, if configured).
- If nobody answers within `approval_timeout_minutes`, the request expires and
  the engine is told **no** (the usual expiry path of the approval gate). The
  run then continues without that action, or fails if the engine gives up.
- Saved "always allow" rules are explicit decisions you made earlier and apply
  as in a chat; commands on the safety floor are never allowed by a rule, so a
  person always decides those.

### Restart recovery

When the backend starts, any run still marked `running` or `needs_input`
belonged to the process that stopped. It becomes `interrupted` and is **never
re-run** (it may already have had side effects); a notification says so. Its
turn is ended by the thread runtime's usual lease sweep. Queued runs that had
not started yet are kept and start normally (or are recorded as `missed` if
they are now later than the catch-up window). Because a run is marked
`running` before its turn is created, a crash in between also leaves an
`interrupted` run, not a second start.

## Webhooks

`POST /routines/{id}/webhook` enables the webhook, or rotates its secret, and
returns the secret **once**. `DELETE` turns it off.

```
curl -X POST http://127.0.0.1:8000/hooks/12 \
  -H "Authorization: Bearer rt_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-event-123" \
  -d '{"event": "deploy", "status": "failed"}'
```

- The bearer secret is checked (constant-time, against the stored hash)
  before the body is read. An unknown routine and a wrong secret get the same
  401.
- The body is limited to `ROUTINE_WEBHOOK_MAX_BYTES` (default 64 KiB; larger
  is 413) and must be UTF-8 text.
- Send an optional `Idempotency-Key` header (1–128 printable ASCII characters,
  without spaces) to identify a delivery. For seven days after acceptance, a
  retry with the same key, body and content type returns the original run ID,
  including after restart, interruption, completion or pausing. It never
  queues or replays that run. A changed body/content type with that key answers
  409; malformed keys answer 400. Keys are scoped to the routine and stored
  only as SHA-256 hashes. Use a fresh key for each new event.
- Receipts and queued runs commit atomically; concurrent retries admit one run.
  Receipt expiry is fixed at the first acceptance and expired entries are
  removed on the routine's next keyed delivery. After seven days, reusing a
  key can create a new run. Calls without a key are independent deliveries.
- Authentication, body size and UTF-8 checks still apply to retries. Rotating
  or disabling the secret revokes old credentials, including for receipt reads.
- A paused routine answers 409 for new deliveries. At most 3 webhook runs per
  routine may be unfinished at once; more answer 429. A valid receipt retry
  consumes no queue slot and can return its original run while paused.
- Accepted calls answer 202 with the run id; the run starts within one poll.
- The body is appended to the routine's prompt inside a clearly delimited
  block that says it is untrusted data, with `<`, `>` and `&` escaped so the
  payload cannot close the block. This is formatting, not a guarantee: an
  engine can still be influenced by text it reads, which is why unattended
  runs ask before acting.

### Ingress

The main API is only for this machine (local access check). To receive
webhooks from elsewhere, run the separate ingress app, which serves only
`GET /health` and `POST /hooks/{id}` and nothing else:

```
uv run uvicorn app.ingress:app --host 127.0.0.1 --port 8788
```

Put a tunnel or reverse proxy in front of that port only. The ingress writes a
queued run to the database; the main backend process starts it. The main
backend also answers `POST /hooks/{id}` itself, for local callers.

## Notifications

Routine events create rows in an in-app notification feed
(`GET /notifications`, unread count, mark read): a run that needs input,
failed, was missed or interrupted, and a run that completed. A skipped
occurrence is only recorded in the run history, so a long run of a frequent
routine does not flood the feed. The chat
header shows a bell with the unread count. When `TELEGRAM_BOT_TOKEN` and
`ROUTINE_TELEGRAM_CHAT_ID` are set, the same messages are also sent to that
Telegram chat.

Feed entries remain after their routine or conversation is deleted. Deleting
a linked conversation clears the entry's `thread_id` while preserving its text
and read state, so it no longer opens a missing conversation. On upgrade, a
data migration clears links to conversations that were deleted earlier.

## Import and export

`GET /routines/{id}/export` returns the definition without any secret.
`POST /routines/import` creates routines from such documents, always
**paused** and without a webhook, so an imported routine never runs until you
look at it and resume it.

## API

All under `/api/v1`, behind the local access check:

```
GET    /routines                    list (with next run, latest run, webhook on/off)
POST   /routines                    create
POST   /routines/preview            summary + next three dates for a draft schedule
POST   /routines/import             import documents (created paused)
GET    /routines/runs               recent runs of all routines
GET    /routines/{id}               one routine
PATCH  /routines/{id}               edit
DELETE /routines/{id}               delete (and its run history)
POST   /routines/{id}/pause         pause
POST   /routines/{id}/resume        resume (next run computed from now)
POST   /routines/{id}/run           run now (409 while a run is active)
GET    /routines/{id}/runs          its run history
GET    /routines/{id}/export        definition without secrets
POST   /routines/{id}/webhook       enable or rotate; returns the secret once
DELETE /routines/{id}/webhook       disable
GET    /notifications               feed (newest first)
GET    /notifications/unread-count
POST   /notifications/{id}/read
POST   /notifications/read-all
```

And outside `/api/v1`: `POST /hooks/{id}` (bearer secret).

## Limits

- The backend must be running for routines to run; a sleeping computer runs
  nothing, and occurrences missed while it is off follow the catch-up rule.
- One backend process schedules and runs routines (the single-process limit
  of the thread runtime). The ingress may be a second process; it only queues.
- A run that was interrupted is not retried automatically; only `failed`
  runs are, and only when the routine has `retry_limit` above 0.
- Webhook deliveries are not de-duplicated: a sender that retries a delivery
  starts another run.

## Connected apps

The editor lets you authorize exact actions and connected accounts once per
routine. The agent must also have matching app and account access. Scheduled and
manual runs can use granted reads, send a one-recipient plain-text Gmail email,
create a new GitHub `campaign/` branch, or commit a file on that branch without
repeated action approvals. Plan mode refuses writes. Webhook, retry and
computer-backed runs receive no app tools.

New grants apply on the next run and revocations stop subsequent calls. Writes
are reserved before dispatch and the same exact request cannot be replayed in
that run. Run history shows receipts and uncertain outcomes. A new manual or
scheduled run can perform the work again: check the app before rerunning after
an uncertain result. External changes are not covered by file Undo. Other writes,
remain unavailable except for the separate confined draft mode below. See [Connected apps](CONNECTED_APPS.md#routine-specific-app-access).


## Quiet results

The editor's quiet reporting setting is off by default. A scheduled run may
suppress its completion notification only after an explicit no-change request
and successful, complete receipts for every configured read action/account.
Empty output, failed or truncated reads, questions, approvals, writes and useful
reports cannot silently count as no change. Manual runs remain visible, and
history retains the outcome and checked-source receipt references. Reporting a
source failure keeps partial output visible. The explicit outcome tool currently
uses the team tool bridge; engines without that bridge retain visible unknown
outcomes. This checks read coverage, not semantic accuracy of the agent's answer.

## Checked-message draft mode

Select Prepare checked reply draft with Read message and Read Gmail profile for
the same account. Combine it only with compatible Gmail reads, never send or
repository writes. The agent must have Gmail write scope. Execution uses a fresh
Claude conversation with built-in host tools, memory, skills, team tools and
fallback disabled. Unsupported engines refuse this mode; exact read and draft
grants remain required.

The routine reads the exact message, then supplies message ID, thread ID,
subject and plain-text body. The server rechecks authoritative Gmail headers,
derives the single From address, refuses ambiguous/different Reply-To or self
addresses, and verifies current grants before dispatch. Missing provider header
shapes fail closed. The one draft attempt is reserved durably before dispatch;
changed body text, concurrent requests, restart or an unknown response cannot
obtain another attempt in the same run. Check Gmail before starting a new run
after uncertainty. A draft is never a send, and a live Gmail run is still needed
to qualify provider response shapes and the approval experience.
