# openclaw-mail-bridge
`openclaw-mail-bridge` is a Node.js daemon that mirrors Gmail and Yandex Mail into a local SQLite archive, builds a chunk-aware retrieval layer for agents, and forwards only new messages to OpenClaw hooks.

It is designed for a practical “augment-style” mail workflow:

- keep a searchable local mirror of mail
- preserve structured metadata and message bodies
- backfill historical mail without replaying old notifications
- deliver only newly received mail into an agent pipeline
- retrieve relevant messages later with chunk-level search

## Features
- Read-only Gmail ingestion via Gmail API + OAuth refresh token
- Read-only Yandex ingestion via IMAP + app password
- Local SQLite archive with FTS5 indexes
- Separate storage for `body_text`, `body_html`, previews, and headers
- Chunk-level indexing for higher-quality retrieval over long messages
- Deduplication by `provider + account + messageId`
- Bootstrap mode that skips existing mail on first start
- Historical backfill without sending old messages to delivery hooks
- Agent-friendly CLI for `search`, `message`, and `thread`
- Optional message metadata output with headers
- Continuous daemon mode or macOS LaunchAgent deployment

## How it works
The bridge has two responsibilities:

1. **Archive mail locally**
   - Poll configured providers
   - Normalize message content
   - Store message bodies, metadata, and retrieval chunks in SQLite

2. **Deliver only fresh mail to OpenClaw**
   - On first run, establish a baseline instead of replaying the entire inbox
   - On later runs, send only newly observed messages to the configured hook

This separation keeps the retrieval archive rich while preventing accidental notification floods.

## Repository layout
- `src/` — application code
- `src/providers/` — provider-specific Gmail and Yandex integrations
- `scripts/` — helper scripts, including LaunchAgent installation
- `launchd/` — LaunchAgent plist template for macOS
- `config/` — example OpenClaw hook mapping

## Requirements
- Node.js 20+ recommended
- npm
- SQLite support through `better-sqlite3`
- A Gmail OAuth app if Gmail ingestion is enabled
- A Yandex app password if Yandex ingestion is enabled
- An OpenClaw hook endpoint if delivery is enabled

## Quick start
1. Install dependencies:

```bash
npm install
```

2. Copy the environment template:

```bash
cp .env.example .env
```

3. Fill in the credentials for the providers you want to enable.

4. Validate the configuration:

```bash
npm run doctor
```

5. Create the initial baseline without replaying existing mail:

```bash
npm run once
```

6. Optionally backfill archive history:

```bash
npm run backfill -- --days 365
```

7. Test retrieval:

```bash
npm run search -- --query "invoice from alice last month"
```

8. Run continuously:

```bash
npm start
```

## Installation notes
This project is intentionally read-only toward mail providers:

- Gmail access uses the Gmail read-only scope
- Yandex access uses IMAP for reading mail
- the bridge does not send mail or modify messages

Secrets should stay in `.env`, which is ignored by git. Do not commit real provider credentials, OAuth tokens, app passwords, or local database files.

## Configuration
Copy `.env.example` to `.env` and update only the variables you need.

### Core settings
- `POLL_INTERVAL_MS` — polling interval for continuous mode
- `DB_PATH` — SQLite database location
- `LOG_LEVEL` — logging verbosity
- `BOOTSTRAP_MODE=skip-existing` — on first start, record the current position without delivering old mail

### OpenClaw delivery
- `OPENCLAW_HOOK_URL` — hook endpoint such as `http://127.0.0.1:18789/hooks/mail`
- `OPENCLAW_HOOK_TOKEN` — bearer token used for delivery
- `OPENCLAW_DELIVERY_ENABLED` — enable or disable delivery
- `OPENCLAW_DELIVERY_TIMEOUT_MS` — hook request timeout

### Archive and retrieval tuning
- `MAIL_BODY_MAX_CHARS` — max plain-text body size stored per message
- `MAIL_HTML_MAX_CHARS` — max HTML body size stored per message
- `BACKFILL_DEFAULT_DAYS` — default historical range for backfill
- `ARCHIVE_BATCH_SIZE` — batch size for archive writes and batched provider work
- `RETRIEVAL_CHUNK_SIZE` — text chunk size used for retrieval indexing
- `RETRIEVAL_CHUNK_OVERLAP` — overlap between chunks
- `RETRIEVAL_DEFAULT_LIMIT` — default number of search results
- `RETRIEVAL_CANDIDATE_MULTIPLIER` — number of FTS candidates considered before reranking
- `RETRIEVAL_THREAD_PREVIEW_LIMIT` — number of messages returned in thread preview mode

## Provider setup
You can configure multiple accounts of the same provider by using numbered prefixes such as `GMAIL_2_*`, `GMAIL_3_*`, `YANDEX_2_*`, and `YANDEX_3_*`.

### Gmail
Gmail uses the Gmail API with a read-only OAuth refresh token.

Required variables:
- `GMAIL_ENABLED=true`
- `GMAIL_ACCOUNT`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

Optional tuning:
- `GMAIL_LABEL=INBOX`
- `GMAIL_MAX_SCAN=25`
- `GMAIL_FETCH_CONCURRENCY=12`

There is also a helper script for obtaining a refresh token:

```bash
node scripts/get-gmail-refresh-token.mjs
```

### Yandex
Yandex uses IMAP with an app password.

Required variables:
- `YANDEX_ENABLED=true`
- `YANDEX_ACCOUNT`
- `YANDEX_USERNAME`
- `YANDEX_APP_PASSWORD`

Optional tuning:
- `YANDEX_IMAP_HOST=imap.yandex.com`
- `YANDEX_IMAP_PORT=993`
- `YANDEX_IMAP_SECURE=true`
- `YANDEX_MAILBOX=INBOX`
- `YANDEX_PARSE_CONCURRENCY=8`

## CLI usage
### Run modes
- `npm start` — start the continuous polling loop
- `npm run once` — execute a single polling cycle
- `npm run doctor` — validate configuration and provider setup

### Archiving
Archive mail without sending historical messages to OpenClaw:

```bash
npm run backfill -- --days 365
```

Or backfill an explicit date range:

```bash
npm run backfill -- --since 2025-01-01 --until 2026-01-01
```

### Retrieval
Search the local archive:

```bash
npm run search -- --query "contract renewal with acme"
```

Fetch a single message in plain text:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format text
```

Fetch the HTML version:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format html
```

Fetch both text and HTML plus metadata:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format both --include-metadata
```

Fetch a thread starting from a message:

```bash
npm run thread -- --id gmail:me@example.com:<message-id> --format text
```

Fetch a thread by a known thread key:

```bash
npm run thread -- --thread-key gmail:me@example.com:thread:abc123
```

## Local database model
The bridge stores state in SQLite and uses FTS5 for retrieval.

Main tables and indexes:
- `cursors` — polling and backfill cursors
- `seen_messages` — messages already delivered to OpenClaw
- `mails` — canonical archived message records
- `mails_fts` — whole-message full-text index across metadata and body
- `mail_chunks` — chunked text segments derived from message bodies
- `mail_chunks_fts` — chunk-level full-text index for retrieval

The `mails` table stores fields such as:
- `body_text`
- `body_html`
- `body_text_preview`
- `headers_json`
- `provider_ref`
- `mailbox`

## Retrieval model
Retrieval is based on a local mirror plus SQLite FTS5 with chunk-level indexing and lightweight reranking.

In practice, the flow is:
- search relevant body chunks and metadata
- collapse chunk hits into message-level candidates
- rerank by factors such as coverage, subject, snippet, chunk hits, and recency
- fetch the full message in `text`, `html`, or `both` format when needed

This is not a vector database, but it is intentionally optimized for fast, inspectable, local-first mail retrieval.

## OpenClaw hook payload
The bridge sends payloads like this:

```json
{
  "source": "openclaw-mail-bridge",
  "messages": [
    {
      "id": "gmail:me@example.com:abc123",
      "provider": "gmail",
      "account": "me@example.com",
      "messageId": "abc123",
      "threadId": "thread-1",
      "from": "Alice <alice@example.com>",
      "subject": "Need invoice today",
      "snippet": "Can you send the invoice by 5pm?",
      "body": "Normalized body text",
      "bodyText": "Plain text body when available",
      "bodyHtml": "<html>...</html>",
      "receivedAt": "2026-03-27T16:40:00.000Z"
    }
  ]
}
```

An example hook mapping is available in `config/openclaw-hooks.example.json`.

## Running as a macOS LaunchAgent
The repository includes a plist template in `launchd/com.openclaw.mail-bridge.plist.template` and an installer script:

```bash
./scripts/install-launchd.sh
```

The installer:
- resolves the current project directory
- finds the active `node` binary
- writes `~/Library/LaunchAgents/com.openclaw.mail-bridge.plist`
- reloads the LaunchAgent

Logs are written to:
- `logs/mail-bridge.out.log`
- `logs/mail-bridge.err.log`

## Operational advice
- Run `npm run doctor` before the first production start
- Start with `npm run once` to establish the baseline safely
- Use `backfill` only when you want to populate the archive with historical mail
- Keep `OPENCLAW_DELIVERY_ENABLED=true` only when hook delivery is desired
- Monitor the local database size if you retain large HTML bodies across many accounts

## License
No license has been added yet. If you plan to make the repository broadly reusable, add a license file before wider distribution.
