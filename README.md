# openclaw-mail-bridge
`openclaw-mail-bridge` is a Node.js service that:

- copies mail from Gmail and Yandex into a local SQLite database
- keeps the archive searchable
- sends only new incoming messages to OpenClaw hooks

It is useful if you want your agent to work with real mail history without depending on a live mailbox search every time.

## Features
- Read-only Gmail support via Gmail API + OAuth refresh token
- Read-only Yandex support via IMAP + app password
- Local SQLite archive with full-text search
- Separate storage for plain text, HTML, previews, and headers
- Better search results on long emails by indexing smaller text chunks
- No duplicate messages for the same `provider + account + messageId`
- Safe first start: existing mail is not re-sent to OpenClaw
- Backfill old mail into the archive without replaying notifications
- Simple CLI for `search`, `message`, and `thread`
- Optional metadata output when you need full headers
- Can run as a normal process or as a macOS LaunchAgent

## How it works
The service does two different jobs:

1. **Save mail locally**
   - Check configured mail accounts
   - Extract message content
   - Store bodies, metadata, and search chunks in SQLite

2. **Send only new mail to OpenClaw**
   - On first run, remember the current position instead of replaying the whole inbox
   - On later runs, send only newly seen messages to the configured hook

This keeps the archive complete while avoiding a flood of old notifications.

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
- A Gmail OAuth app if Gmail is enabled
- A Yandex app password if Yandex is enabled
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

3. Fill in the credentials for the mail providers you want to use.

4. Validate the configuration:

```bash
npm run doctor
```

5. Create the initial baseline without sending old mail:

```bash
npm run once
```

6. Optionally backfill archive history:

```bash
npm run backfill -- --days 365
```

7. Test search and retrieval:

```bash
npm run search -- --query "invoice from alice last month"
```

8. Run continuously:

```bash
npm start
```

## Installation notes
This project is intentionally read-only:

- Gmail access uses the Gmail read-only scope
- Yandex access is used only for reading mail
- the bridge does not send mail or modify messages in your mailbox

Secrets should stay in `.env`, which is ignored by git. Do not commit real credentials, OAuth tokens, app passwords, or local database files.

## Configuration
Copy `.env.example` to `.env` and change only the values you need.

### Core settings
- `POLL_INTERVAL_MS` — how often the service checks for new mail
- `DB_PATH` — where the SQLite database is stored
- `LOG_LEVEL` — log verbosity
- `BOOTSTRAP_MODE=skip-existing` — on first start, remember current mail without delivering old messages

### OpenClaw delivery
- `OPENCLAW_HOOK_URL` — hook URL such as `http://127.0.0.1:18789/hooks/mail`
- `OPENCLAW_HOOK_TOKEN` — bearer token for requests
- `OPENCLAW_DELIVERY_ENABLED` — turn delivery on or off
- `OPENCLAW_DELIVERY_TIMEOUT_MS` — request timeout

### Archive and search tuning
- `MAIL_BODY_MAX_CHARS` — max plain-text body length stored per message
- `MAIL_HTML_MAX_CHARS` — max HTML body length stored per message
- `BACKFILL_DEFAULT_DAYS` — default time range for backfill
- `ARCHIVE_BATCH_SIZE` — batch size for archive writes and provider processing
- `RETRIEVAL_CHUNK_SIZE` — text chunk size used for indexing
- `RETRIEVAL_CHUNK_OVERLAP` — overlap between chunks
- `RETRIEVAL_DEFAULT_LIMIT` — default number of search results
- `RETRIEVAL_CANDIDATE_MULTIPLIER` — how many initial matches are considered before final sorting
- `RETRIEVAL_THREAD_PREVIEW_LIMIT` — number of messages returned in thread preview mode

## Provider setup
You can connect multiple accounts of the same provider by using numbered prefixes such as `GMAIL_2_*`, `GMAIL_3_*`, `YANDEX_2_*`, and `YANDEX_3_*`.

### Gmail
Gmail uses the Gmail API with a read-only OAuth refresh token.

Required variables:
- `GMAIL_ENABLED=true`
- `GMAIL_ACCOUNT`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

Optional settings:
- `GMAIL_LABEL=INBOX`
- `GMAIL_MAX_SCAN=25`
- `GMAIL_FETCH_CONCURRENCY=12`

There is also a helper script for getting a refresh token:

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
Save old mail into the local archive without sending old messages to OpenClaw:

```bash
npm run backfill -- --days 365
```

Or backfill a specific date range:

```bash
npm run backfill -- --since 2025-01-01 --until 2026-01-01
```

### Search and retrieval
Search the local archive:

```bash
npm run search -- --query "contract renewal with acme"
```

Get a single message in plain text:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format text
```

Get the HTML version:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format html
```

Get both text and HTML plus metadata:

```bash
npm run message -- --id gmail:me@example.com:<message-id> --format both --include-metadata
```

Get a thread starting from a message:

```bash
npm run thread -- --id gmail:me@example.com:<message-id> --format text
```

Get a thread by a known thread key:

```bash
npm run thread -- --thread-key gmail:me@example.com:thread:abc123
```

## Local database
The service stores its state in SQLite and uses FTS5 for search.

Main tables and indexes:
- `cursors` — saved positions for polling and backfill
- `seen_messages` — messages already delivered to OpenClaw
- `mails` — archived messages
- `mails_fts` — full-text search index for messages
- `mail_chunks` — smaller text pieces taken from message bodies
- `mail_chunks_fts` — full-text search index for those chunks

The `mails` table stores fields such as:
- `body_text`
- `body_html`
- `body_text_preview`
- `headers_json`
- `provider_ref`
- `mailbox`

## How search works
Search is based on the local SQLite archive.

In simple terms:
- the service indexes full messages and smaller text chunks
- search looks for relevant chunks and message metadata
- matching chunks are grouped back into message-level results
- when needed, you can then fetch the full message in `text`, `html`, or `both` format

This approach is fast, local, and easy to inspect.

## OpenClaw hook payload
The service sends payloads like this:

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
- finds the current project directory
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
