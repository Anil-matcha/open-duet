# Teams and delegated work

A team has a lead and specialists. Existing agents keep their settings until you choose a lead or add them to the team. A team can contain an agent on any engine; team tools are available through Claude and Codex. Choose the lead and coordinated agents in the new-agent form or existing agent settings. See [chat management](CHAT_MANAGEMENT.md) for conversational setup, supported controls and verification limits.

As of Open Duet `a2e6404` (2026-11-03), Team coordination opens a full-screen
workspace with **Agents**, **Work** and **Rooms** views. Agents shows the lead
and specialists, their configured engine and current idle, working or waiting
state, along with the existing membership controls. Work groups delegated jobs
by attention, running, waiting and finished; cards show the requester, assignee,
parent job, elapsed or completion time, and the existing approval, open-work and
stop actions. Search narrows jobs by brief, status or agent. Rooms lists the
shared conversations that can be opened directly.

The database stores team membership, creation records, jobs, room membership and reply queues. Chat threads keep their existing kind after migration. Job and member work use their own conversation records; room conversation records hold visible messages.

The foundation migration uses additive columns and new tables, with an SQLite-safe downgrade. It does not start paid work or change existing agents automatically.

## Shared rooms

A room is a shared conversation for selected agents, with shared instructions
and one visible transcript. Create one from the Chat page's Rooms panel or let
a Claude or Codex team lead create it with `create_room`. Choose one to twelve agents
when creating it. You can edit the
room name, shared instructions, roster and default responder setting later.

Room settings adds or removes members without deleting the conversation or any
member's work history. Choose one to twelve distinct live agents you own; agents
assigned to a team must belong to your team. Removing the default responder
requires choosing another responder or a different response rule in the same save.
Queued replies for a removed member are skipped. Running work must finish before
removal: use Stop, wait for it to settle, then save. Stop keeps the dispatch busy
while the provider is cancelling, including during startup, and discards late results.
Roster changes appear as durable room notices. A concurrent roster edit refuses a
stale save; reopen settings to review the current members.

Re-adding a member reuses their existing work thread and history, clears Hold, and
starts their next prompt with messages posted after rejoining. Missed messages and
old queued or failed replies are not replayed. Existing conversation history stays
in the room; a re-added member can explicitly search it. While removed, a member
cannot post to the room, receive new room work, search its shared history, or create
new memory from it. Previously learned notes are retained. Deleting the room cleans
up work threads for both active and removed members.

The HTTP roster edit is `PATCH /rooms/{id}` with `member_ids` and the unchanged
`expected_member_ids` from the roster the person reviewed. The room-row lock
serializes edits with message routing and dispatch claims. Responses use
`roster_conflict`, `member_busy` or `invalid_responder` to explain refused edits.
Automated checks on 2026-10-26 cover SQLite and a disposable local PostgreSQL
instance. PostgreSQL lock-barrier tests use independent sessions to verify that
reply completion waits for the room before locking its dispatch, avoids deadlock
with Stop, and rechecks work settled by a preceding writer. Real-provider and
packaged app qualification remain separate gates.

For a message without a tag, choose **Only tagged members**, **One member**, or
**Everyone**. Tag an individual with `@name` or use `@everyone` to direct a
message to members. Members take turns, so room work is queued rather than
running every responder at once. Each member has a separate work conversation;
the room shows replies, pending approvals, progress, failures and links to that
work. Owners can hold or resume a member, stop work, retry a failed dispatch,
and export the room transcript as Markdown or JSON. Tool approvals still use
each agent's normal approval mode.

The room conversation fills the workspace, with a docked message composer and
a details panel for member controls, shared instructions and room actions. The
reply queue shows its order and routing reason. The `@` picker supports keyboard
selection; when agent names match, it adds the selected agent's ID to the
mention token so the intended member receives the message.

There is no model-based automatic responder for untagged messages.

## Handing work out without waiting

The lead's `delegate` tool assigns work to one to four teammates and returns receipts at once. The lead then ends its turn. Each result is stored in an inbox; when every awaited result is in, or a teammate asks the person a question, the lead is resumed once in a new turn on the same conversation, with the results in a message written by the app. Results are quoted data and never approve a tool call. `ask_agent` stays for a short question the lead must have answered before it can go on (it waits up to `TEAM_JOB_WAIT_SECONDS`). A teammate that needs the person ends its reply with a last line `NEEDS INPUT: <question>`; the person answers in that teammate's own conversation and the job runs again. Pressing Stop on a lead that is waiting stops what it handed out and it is not resumed. After a restart, a job interrupted before its engine took the prompt is queued again once; otherwise it is marked failed, and a lead whose turn was cut is resumed with a note to check what it already did.

Verification: the migrated SQLite schema and PostgreSQL DDL snapshots were checked locally. Focused macOS source-build checks exercised a Claude lead delegating to specialists and one- and two-member room replies. This does not establish broad engine compatibility, long-running room behavior, hostile-input resistance, or PostgreSQL multi-backend execution.

## When a teammate's run goes wrong

A teammate's chat that fails, stalls (nothing happened for `TURN_STALL_SECONDS`), cannot start, or is cut off by a crash is reported to the lead once the turn has settled. The report is a harness message in the lead's "Team incidents" conversation (listed with your chats): the request, the teammate's last words and what failed, quoted as data inside JSON, redacted, one line each. A Stop is never reported, nor is a shutdown. A failure of a delegated job is reported to the lead that is waiting for it as the job's result, with outcome `stalled` for a stall, not as an incident.

The lead can call `retry_thread` to continue that conversation. It refuses with a code when the caller is not the lead, the teammate or thread is not on the team, the thread is a room or job conversation, it is running, it finished a run since it was reported, it was already retried twice within the hour, or its session is broken. The teammate keeps its own permission mode, and is told the lead asked. Each thread has at most five reports an hour: the third says retries are used up, after the fifth they are muted and you are told once.

If the lead is busy, reports wait and are folded into one turn when it is free; none is refused. If there is no lead, the lead itself failed, or it cannot take the report, you get a notification instead (not twice for something you already heard about, such as a failed routine).

**Escalations** (setting `TEAM_ESCALATIONS`, off by default): a teammate can call `raise_escalation` to flag a gate only you can lift, and an approval left unanswered for ten minutes is flagged the same way. The lead is told in "Team escalations" and assigns nothing: it tells you what is asked and where to answer. Three flags an hour per thread, then muted.

Not verified: a real Claude lead taking an incident and retrying; computers for notice turns (a lead whose computer is unavailable fails the report turn and you are notified).

## Today brief

The lead's existing Needs you card now appears as **Today**. It combines
pending approvals and teammate questions, failed/missed/interrupted routines,
automatic pauses, durable engine sign-in/limit failures, due incomplete tasks,
and aggregated routine completions for the owner's local day. Each row names
its source, shows its source timestamp and links to the conversation, routine
history or task. Recorded engine failures persist across refreshes until a
later settled turn on that provider supersedes them. Live engine probes remain
separate from those recorded failures.

Presence supplies the owner's IANA time zone; the existing once-a-minute tick
updates one card per local day only when its content changes. It starts no AI
turn, avoids an active conversation and suppresses empty first cards. Completion
rows do not create notifications. Calendar and Gmail are explicitly unavailable;
an unavailable connector is never reported as an empty day or inbox. New local
question, task and completion queries each return at most 100 records; the
compact card shows six rows and counts additional collected rows.

Concurrent first visits and Today refreshes are serialized in the database,
including across backend processes. The card, its notification and a new Today
conversation commit together. Publishing locks the conversation before checking
that it is idle, so it cannot insert a card after a turn starts.
