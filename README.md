# openclaw-mail-bridge
Read-only mail archive + MCP server for Gmail and Yandex.

It lets an agent:
- see recent mail across multiple inboxes
- search old mail locally
- open full messages and threads
- work through MCP instead of shell scripts

## Fast setup
1. Create a config:

```bash
npx -y openclaw-mail-bridge init-config
```

2. Fill in:
- `~/.config/openclaw-mail-bridge/.env`

3. Check that config is valid:

```bash
npx -y openclaw-mail-bridge doctor
```

4. Add the MCP server:

```json
{
  "command": "npx",
  "args": ["-y", "openclaw-mail-bridge-mcp"]
}
```

## What the agent gets
MCP tools:
- `mail_today`
- `mail_list`
- `mail_search`
- `mail_message`
- `mail_thread`

Important behavior:
- if you do **not** specify an account, `mail_today` and `mail_list` return top-N **per mailbox**
- every result includes mailbox/account context
- the service is **read-only**

## Minimal config
Main settings in `~/.config/openclaw-mail-bridge/.env`:

- `DB_PATH` — local SQLite archive path
- `GMAIL_ENABLED=true` plus Gmail credentials
- `YANDEX_ENABLED=true` plus Yandex credentials
- `OPENCLAW_DELIVERY_ENABLED=false` if you only want MCP and no hook delivery

Relative `DB_PATH` values are resolved from the config directory.

## OpenClaw example
You can register it directly with:

```bash
openclaw mcp set openclaw-mail-bridge '{"command":"npx","args":["-y","openclaw-mail-bridge-mcp"]}'
```

Then restart the gateway if needed:

```bash
openclaw gateway restart
```

## Useful commands
Validate config:

```bash
npx -y openclaw-mail-bridge doctor
```

Create initial baseline without replaying old mail:

```bash
npx -y openclaw-mail-bridge --once
```

Backfill archive:

```bash
npx -y openclaw-mail-bridge backfill --days 365
```

Run the MCP server directly:

```bash
npx -y openclaw-mail-bridge-mcp
```

## Notes
- Gmail uses read-only OAuth access
- Yandex uses read-only IMAP access
- mail is stored locally in SQLite
- the bridge does not send mail or modify messages

## License
MIT
