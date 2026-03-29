# openclaw-mail-bridge
Node.js daemon, который зеркалирует Gmail и Яндекс Почту локально в SQLite, строит chunk-aware retrieval слой для агента и продолжает отправлять только новые письма в OpenClaw hooks.

## Что уже решено
- первый старт делает baseline и пропускает уже существующие письма для delivery path
- новые письма дедуплицируются по `provider + account + messageId`
- архив хранит отдельно `body_text`, `body_html`, превью и metadata
- retrieval идёт не только по whole-message body, но и по text chunks
- есть backfill за период без отправки старых писем в OpenClaw
- доступны `search`, `message` и `thread` команды для agent-friendly retrieval
- `message` и `thread` умеют `--format text|html|both`
- при необходимости можно запросить headers/metadata через `--include-metadata`
- доставка в OpenClaw идёт через `Authorization: Bearer <token>`
- сервис можно запускать как обычный процесс или как LaunchAgent на macOS

## Быстрый старт
1. Скопируй `.env.example` в `.env`
2. Заполни секреты для нужных провайдеров
3. Проверь конфиг:
   - `npm run doctor`
4. Инициализируй baseline для новых писем:
   - `npm run once`
5. При необходимости архивируй историю за период:
   - `npm run backfill -- --days 365`
6. Проверь retrieval:
   - `npm run search -- --query "invoice from alice last month"`
7. Постоянный запуск:
   - `npm start`

## Что лежит в локальной базе
- `cursors` — курсоры polling/backfill
- `seen_messages` — что уже было отправлено в OpenClaw
- `mails` — локальный архив писем
- `mails_fts` — полнотекстовый индекс по whole-message metadata/body
- `mail_chunks` — чанки текстового тела писем
- `mail_chunks_fts` — индекс по chunks для более точного retrieval

## Команды
- `npm start` — обычный polling loop
- `npm run once` — один polling cycle
- `npm run doctor` — проверка env-конфига
- `npm run backfill -- --days 365` — архивировать письма за последние N дней без delivery
- `npm run backfill -- --since 2025-01-01 --until 2026-01-01` — backfill по диапазону
- `npm run search -- --query "contract renewal with acme"` — chunk-aware поиск по локальному архиву
- `npm run message -- --id gmail:me@example.com:<message-id> --format text` — получить письмо в plain text
- `npm run message -- --id gmail:me@example.com:<message-id> --format html` — получить письмо в html
- `npm run message -- --id gmail:me@example.com:<message-id> --format both --include-metadata` — получить обе версии и headers
- `npm run thread -- --id gmail:me@example.com:<message-id> --format text` — поднять тред по письму
- `npm run thread -- --thread-key gmail:me@example.com:thread:abc123` — поднять тред по known thread key

## Переменные
- `BOOTSTRAP_MODE=skip-existing` — на первом запуске только фиксирует текущую точку и не отправляет старые письма
- `POLL_INTERVAL_MS` — интервал опроса
- `OPENCLAW_HOOK_URL` — endpoint вида `http://127.0.0.1:18789/hooks/mail`
- `OPENCLAW_HOOK_TOKEN` — hook token OpenClaw
- `MAIL_BODY_MAX_CHARS` — сколько текста тела письма хранить локально
- `MAIL_HTML_MAX_CHARS` — сколько html тела письма хранить локально
- `BACKFILL_DEFAULT_DAYS` — период backfill по умолчанию
- `ARCHIVE_BATCH_SIZE` — размер batched SQLite upsert и batched IMAP processing
- `GMAIL_FETCH_CONCURRENCY` — сколько `messages.get` выполнять параллельно в Gmail backfill/poll
- `YANDEX_PARSE_CONCURRENCY` — сколько IMAP писем парсить параллельно в batched Yandex backfill/poll
- `RETRIEVAL_CHUNK_SIZE` — размер chunk для text retrieval
- `RETRIEVAL_CHUNK_OVERLAP` — overlap между chunks
- `RETRIEVAL_DEFAULT_LIMIT` — сколько результатов отдавать из `search`
- `RETRIEVAL_CANDIDATE_MULTIPLIER` — сколько FTS-кандидатов брать до финального rerank
- `RETRIEVAL_THREAD_PREVIEW_LIMIT` — сколько писем отдавать в `thread`

## Gmail
Используется Gmail API с read-only OAuth refresh token.

Нужно заполнить:
- `GMAIL_ENABLED=true`
- `GMAIL_ACCOUNT`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

Для второго и следующих Gmail-ящиков можно использовать такие же префиксы:
- `GMAIL_2_*`
- `GMAIL_3_*`

## Яндекс
Используется IMAP + app password.

Нужно заполнить:
- `YANDEX_ENABLED=true`
- `YANDEX_ACCOUNT`
- `YANDEX_USERNAME`
- `YANDEX_APP_PASSWORD`

Для второго и следующих Яндекс-ящиков можно использовать:
- `YANDEX_2_*`
- `YANDEX_3_*`

## OpenClaw hook
Bridge отправляет payload формата:

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

Для OpenClaw удобно сделать mapping на `/hooks/mail`, который анализирует важность письма и шлёт алерт в Telegram только для важных кейсов.

## Retrieval модель
Текущая версия retrieval — это локальный mirror + SQLite FTS5 + chunk-level index + лёгкий rerank по coverage/subject/snippet/chunk hits/свежести. Это всё ещё не vector DB, но уже ближе к augment-style context engine:
- сначала ищутся релевантные куски письма и metadata
- потом результаты схлопываются до message-level hits
- затем агент может запросить полное письмо в `text`, `html` или `both`

## launchd
Шаблон plist лежит в `launchd/com.openclaw.mail-bridge.plist.template`.
Скрипт установки:

```bash
./scripts/install-launchd.sh
```
