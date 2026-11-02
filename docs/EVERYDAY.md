# Everyday features: search, attachments, workspace files, usage

Four small features that make daily use easier, plus a pass over the chat's
error and empty states. Each one works on SQLite and PostgreSQL alike and needs
no new tables: they read what the app already stores (threads, turns, events)
or keep files next to the database.

## Conversation search

`GET /api/v1/search?q=...` (chat scope).

- **What is searched.** Conversation titles, what the person wrote
  (`turn.started` events) and what the agent answered (`assistant.message`
  events). Tool output, approvals and typing previews are not searched.
- **How.** Every word of the query (up to 6) must appear, in any order and
  case, inside one title or one message: a portable `lower(...) LIKE` with
  escaped wildcards. Message text is read from the event's JSON with
  SQLAlchemy's JSON element access, which compiles to `json_extract` on SQLite
  and `->>` on PostgreSQL. No FTS index: a personal history is small enough
  for a scan, and one query path on both databases is easier to trust. A
  query under 2 characters returns nothing.
- **Filters.** `agent_id`, `since` / `until` (ISO dates, inclusive),
  `include_archived` (off by default), `limit` (1 to 100, default 40).
- **Paging.** `offset` (0 to 500) skips that many hits. The response carries
  `has_more` and, while it is true, `next_offset` to ask for next; a page can
  come back empty after a full last one. A conversation with any message hit
  never also shows its title as a hit, so pages come from one stable order.
  Hits beyond 500 are not reachable; narrow the query or the dates.
- **Result.** Newest first. Each hit names its conversation (id, title, agent,
  archived), where it matched (`title`, `user` or `assistant`, with the event
  `seq` and turn), when, and a snippet of about 160 characters around the
  first match with `highlights`: `[start, length]` pairs into the snippet, one
  per matched word occurrence. The UI marks them; it never renders the snippet
  as HTML.
- **UI.** A search box at the top of the conversation list. Typing waits a
  moment, then shows hits with the matching words marked; choosing one opens
  that conversation. Filters: archived, agent.

## Attachments and images

`POST /api/v1/threads/{id}/attachments` (multipart, field `file`) uploads one
file and returns `{id, name, mime, bytes, kind}`. `POST .../turns` takes
`attachment_ids` (up to 8). `GET .../attachments/{attachment_id}` returns the
bytes. All chat scope.

- **Storage.** A private folder outside every workspace:
  `<data>/attachments/<thread id>/<uuid><ext>` with a small `<uuid>.json`
  beside it (display name, type, size, sha256). `<data>` is
  `ATTACHMENTS_DIR`, else `~/.open-dots/attachments`, else the desktop data
  folder. Folders `0700`, files `0600`. The stored file name is always a fresh
  UUID plus an extension chosen from the type; the person's file name is only
  ever a display name (control characters and path separators removed,
  shortened).
- **What is accepted.**
  - Images: PNG, JPEG, GIF, WebP, up to 10 MB, and the bytes must start with
    that format's signature (a renamed file is refused).
  - Text: `.txt .md .csv .tsv .json .log .yaml .yml .xml .html .css .js .ts
    .tsx .py .sh .sql .toml .ini`, up to 1 MB, valid UTF-8 with no NUL bytes.
  - Anything else: 415 with the list above. Over a limit: 413. An empty file:
    400. A thread holds at most 200 MB of attachments (507 after).
- **To the engine.** Text files are added to the message as fenced blocks
  under their display names (every engine reads them). Images go only to an
  engine whose capability flags say `images`. Today that is Claude: the CLI
  gets one stream-json user message with text and base64 image content blocks.
  Sending an image to any other engine is refused before the turn starts:
  422 `images_unsupported`, "<Engine> can't read images. Remove the image or
  use an engine that can."
- **In the transcript.** The `turn.started` event carries the attachment list
  (never the bytes), so the user's message shows image thumbnails and file
  chips, after a reload too. The prompt stored on the turn stays what the
  person typed.
- **Composer.** Paste an image, drag files onto the chat, or pick with the
  paperclip. Chips show name and size with a remove button; an upload that
  fails says why and is not sent.

## Workspace files

`GET /api/v1/threads/{id}/files?path=` lists a folder of the conversation's
pinned workspace (for an agent's conversation, the agent's workspace).
`GET .../files/content?path=` previews a text file (first 256 KB) or an image
(up to 10 MB), whose bytes come from `GET .../files/raw?path=`.
`GET .../files/download?path=` downloads a file (up to 50 MB).
`GET .../files/zip?path=` downloads a folder, or the whole workspace when
`path` is empty, as a zip (at most 2000 files and 200 MB in total before
compression; over either is 413 `too_large`).
Needs the `files` scope (or admin): a paired chat-only device cannot browse files. The
zip stays admin-only.

Confinement, checked on every request:

- `path` is relative. An absolute path, a `..` part, a backslash, NUL or a
  drive prefix is 400 before the disk is touched.
- The workspace root and the target are both canonicalised (`realpath`); the
  target must be inside the root. A symlink that points outside (file or
  folder, anywhere on the path) is 403 `outside_workspace`; a listing skips
  such entries rather than show them.
- The file is opened with `O_NOFOLLOW` and its inode compared with the
  canonical path after opening, so a swap between check and open is refused.
- Secrets are never served, even inside the workspace: `.env` and `.env.*`,
  `.git/`, `.ssh/`, `.aws/`, `.gnupg/`, `.netrc`, `.npmrc`, `.pypirc`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`.
  Listings show them as `hidden` with no size; reading one is 403
  `secret_file`.
- Downloads are `Content-Disposition: attachment` with a safe file name,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
  A listing returns at most 500 entries (`truncated` says so).
- A zip applies the same rules to every file in it: it holds only what a
  listing would show as a file (secret files, `.git/` and the other secret
  folders, links out of the workspace and special files are left out, with no
  error), each file is opened with the same `O_NOFOLLOW` and inode check
  (which also refuses a file whose folder was swapped for a link to a secret
  folder), and links to folders are not followed (a link loop cannot make it
  grow). Files and folders whose names are unsafe inside a zip (a backslash, a
  drive prefix, control or bidi/format characters, names that are not UTF-8)
  are left out too; the `X-Skipped-Unsafe-Names` header counts them. The zip
  is written to a temporary file that is deleted once it has been sent, or
  as soon as building it fails; a file that grows past the cap while it is
  being zipped stops the download with 413. Each request stages up to about
  200 MB in the system temporary folder and requests are not limited in
  number; the route is admin-only (the `files` scope does not reach it).

UI: a Files panel for the open conversation: folders, sizes, a text or image
preview, a download link, and **Download zip** for the folder being shown.

## Usage and cost

Engines report tokens and cost at the end of a turn when they know them
(Claude: input, output, cache read and cache write tokens, and cost in USD).
The turn stores exactly what was reported. Nothing is estimated.

- Each finished turn in the transcript shows its tokens and cost, or
  "usage not reported".
- A finished turn's `turn.completed` / `turn.failed` event carries the
  `usage` its engine reported (absent when it reported nothing).
- `GET /api/v1/usage?month=YYYY-MM` (admin; months and days in UTC): totals for the month, by
  conversation, by engine and model, and by day. A total counts `turns`,
  `reported_turns` and `unreported_turns`; `cost_usd` is the sum of reported
  costs and is null when no turn in that group reported one.
- `GET /api/v1/usage.csv?month=YYYY-MM` (admin): one row per turn of that
  month (time, conversation, engine, model, status, tokens, cost), with cells
  that start like a spreadsheet formula neutralised.
- UI: a Usage panel (month picker, totals, by conversation, CSV link), and a
  conversation total in the header.

## Errors and empty states

Every refusal a person can act on has a sentence that says what to do:
images to a text-only engine, a file too big or of the wrong type, search
with no results, an empty workspace, a month with no usage, and a turn that
failed with its reason.

## Not in this version

- Attached text files reach the engine only in the turn they were sent with;
  an engine that rebuilds context from stored history (OpenAI-compatible)
  sees the typed message, not the file, on later turns. Text inside attached
  files is not searched.
- SQLite's `lower()` folds ASCII only, so search is case-insensitive for
  ASCII letters; other scripts match case-sensitively there (PostgreSQL folds
  them).

- Ranking by relevance, stemming, or an FTS index.
- PDFs and office documents as attachments; images for Codex, ACP and
  OpenAI-compatible engines.
- Editing or deleting workspace files from the browser.
- Budgets, alerts or price tables for engines that do not report cost.


## Audio and direct podcast media

Attach supported WAV, MP3, M4A, OGG, FLAC or WebM audio, or choose Audio URL for a
direct public media URL. The server advertises availability only when
`AUDIO_TRANSCRIPTION_API_KEY`, ffmpeg and ffprobe are available. It limits audio
to 25 MB and 20 minutes, validates its media format, and asks for explicit OpenAI
processing consent before uploading. Inaccessible pages and unsupported media
return errors instead of fabricated transcripts. The fetcher blocks non-public
addresses and validates every redirect, pins resolved addresses, and bounds
bytes, redirects and time.

The conversation stores original media and the returned transcript. The default
`AUDIO_TRANSCRIPTION_MODEL=gpt-transcribe` returns text without timestamps; the
UI labels timing unavailable instead of inventing it. An explicitly configured
legacy `whisper-1` route can return timed segments, but is supported only until
2027-02-26 according to the [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text). Both remain until the conversation is deleted; temporary validation
files are cleaned after processing. OpenAI's retention policies also apply to
remote transcription. Cancel audio processing stops pending processing and
avoids storing partial output. Review the visible transcript before relying on
names, quotations or a summary; quality and timestamps still need live-provider
qualification. Transcript review turns have tools denied; request later actions
in a separate person-authored turn. Source playback and summary quality still
need installed-app checks. A configured server feature does not establish that
packaged desktop builds contain the required media executables.

## Provider sources in Today

With the lead agent's read access and connected accounts, Today shows bounded
inbox records from the last seven days and primary-calendar events for the
local day. Each source keeps IDs, links and timestamps; cancelled and all-day
events are labeled and overlapping timed events show conflicts. The snapshot
is capped at 30 records per provider and labels continuation/truncation as
partial coverage. Multiple accounts without an unambiguous selection are
unavailable rather than guessed. Source failures stay distinct from a quiet
inbox/calendar. A five-minute cache shows when providers were checked and is
invalidated for changed grants, owner, lead, timezone or day. These records
perform no external writes and do not themselves trigger attention alerts.
Live accounts and installed apps remain unqualified.
