import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { buildMailChunks } from "./mail.js";

function tokenizeSearchQuery(query) {
  return [...String(query || "").toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)]
    .map((match) => match[0])
    .filter(Boolean)
    .slice(0, 12);
}

function buildMatchExpression(tokens) {
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function buildPreview(row, tokens) {
  const source = row.chunk_preview || row.chunk_text || row.body_text_preview || row.snippet || row.body_text || row.body || "";
  const normalized = source.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const lowered = normalized.toLowerCase();
  const firstIndex = tokens
    .map((token) => lowered.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstIndex == null) {
    return normalized.slice(0, 320);
  }

  const start = Math.max(0, firstIndex - 100);
  const end = Math.min(normalized.length, start + 320);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function rankSearchRows(rows, query, tokens, limit) {
  const loweredQuery = String(query || "").trim().toLowerCase();
  const aggregated = new Map();

  rows.forEach((row, index) => {
    const haystack = [
      row.from,
      row.to,
      row.cc,
      row.subject,
      row.snippet,
      row.body_text,
      row.body,
      row.chunk_text,
    ].join(" ").toLowerCase();
    const subject = String(row.subject || "").toLowerCase();
    const snippet = String(row.snippet || "").toLowerCase();
    const chunkText = String(row.chunk_text || "").toLowerCase();
    const coverage = tokens.filter((token) => haystack.includes(token)).length;
    const subjectHits = tokens.filter((token) => subject.includes(token)).length;
    const snippetHits = tokens.filter((token) => snippet.includes(token)).length;
    const chunkHits = tokens.filter((token) => chunkText.includes(token)).length;
    const phraseHit = loweredQuery.length >= 4 && haystack.includes(loweredQuery) ? 1 : 0;
    const ageDays = Math.max(0, (Date.now() - new Date(row.received_at).getTime()) / (1000 * 60 * 60 * 24));
    const recencyBoost = Math.max(0, 30 - Math.min(ageDays, 30));
    const score = coverage * 40 + subjectHits * 20 + snippetHits * 12 + chunkHits * 22 + phraseHit * 30 + recencyBoost + Math.max(0, 20 - index);

    const next = {
      id: row.external_id,
      provider: row.provider,
      account: row.account,
      messageId: row.message_id,
      threadId: row.thread_id,
      threadKey: row.thread_key,
      from: row.from,
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      snippet: row.snippet,
      preview: buildPreview(row, tokens),
      receivedAt: row.received_at,
      availableFormats: {
        text: Boolean(row.body_text),
        html: Boolean(row.body_html),
      },
      matchedChunkIndex: row.chunk_index ?? null,
      score,
    };

    const existing = aggregated.get(row.external_id);
    if (!existing || next.score > existing.score) {
      aggregated.set(row.external_id, next);
    } else {
      existing.score += Math.max(1, Math.round(next.score * 0.08));
    }
  });

  return [...aggregated.values()]
    .sort((a, b) => b.score - a.score || b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, limit);
}

function parseCompositeId(id) {
  if (!id) {
    return null;
  }

  const [provider, account, ...rest] = String(id).split(":");
  if (!provider || !account || !rest.length) {
    return null;
  }

  return { provider, account, messageId: rest.join(":") };
}

export function createStateStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cursors (
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, account, key)
    );

    CREATE TABLE IF NOT EXISTS seen_messages (
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      message_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, account, message_id)
    );

    CREATE TABLE IF NOT EXISTS mails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      message_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      provider_ref TEXT NOT NULL DEFAULT '',
      mailbox TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      thread_key TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT NOT NULL DEFAULT '',
      references_header TEXT NOT NULL DEFAULT '',
      from_text TEXT NOT NULL DEFAULT '',
      to_text TEXT NOT NULL DEFAULT '',
      cc_text TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      body_text_preview TEXT NOT NULL DEFAULT '',
      headers_json TEXT NOT NULL DEFAULT '{}',
      received_at TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, account, message_id)
    );

    CREATE INDEX IF NOT EXISTS mails_received_at_idx ON mails(received_at);
    CREATE INDEX IF NOT EXISTS mails_provider_account_idx ON mails(provider, account, received_at);
    CREATE INDEX IF NOT EXISTS mails_thread_key_idx ON mails(thread_key, received_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS mails_fts USING fts5(
      from_text,
      to_text,
      cc_text,
      subject,
      snippet,
      body,
      content='mails',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS mails_ai AFTER INSERT ON mails BEGIN
      INSERT INTO mails_fts(rowid, from_text, to_text, cc_text, subject, snippet, body)
      VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject, new.snippet, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS mails_ad AFTER DELETE ON mails BEGIN
      INSERT INTO mails_fts(mails_fts, rowid, from_text, to_text, cc_text, subject, snippet, body)
      VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject, old.snippet, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS mails_au AFTER UPDATE ON mails BEGIN
      INSERT INTO mails_fts(mails_fts, rowid, from_text, to_text, cc_text, subject, snippet, body)
      VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject, old.snippet, old.body);
      INSERT INTO mails_fts(rowid, from_text, to_text, cc_text, subject, snippet, body)
      VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject, new.snippet, new.body);
    END;

    CREATE TABLE IF NOT EXISTS mail_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mail_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL DEFAULT '',
      chunk_preview TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(mail_id, chunk_index),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS mail_chunks_mail_id_idx ON mail_chunks(mail_id, chunk_index);

    CREATE VIRTUAL TABLE IF NOT EXISTS mail_chunks_fts USING fts5(
      chunk_text,
      content='mail_chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS mail_chunks_ai AFTER INSERT ON mail_chunks BEGIN
      INSERT INTO mail_chunks_fts(rowid, chunk_text)
      VALUES (new.id, new.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS mail_chunks_ad AFTER DELETE ON mail_chunks BEGIN
      INSERT INTO mail_chunks_fts(mail_chunks_fts, rowid, chunk_text)
      VALUES ('delete', old.id, old.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS mail_chunks_au AFTER UPDATE ON mail_chunks BEGIN
      INSERT INTO mail_chunks_fts(mail_chunks_fts, rowid, chunk_text)
      VALUES ('delete', old.id, old.chunk_text);
      INSERT INTO mail_chunks_fts(rowid, chunk_text)
      VALUES (new.id, new.chunk_text);
    END;
  `);

  const getCursorStmt = db.prepare(`SELECT value FROM cursors WHERE provider = ? AND account = ? AND key = ?`);
  const setCursorStmt = db.prepare(`
    INSERT INTO cursors (provider, account, key, value, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, account, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  const hasSeenStmt = db.prepare(`SELECT 1 FROM seen_messages WHERE provider = ? AND account = ? AND message_id = ?`);
  const markSeenStmt = db.prepare(`INSERT OR IGNORE INTO seen_messages (provider, account, message_id) VALUES (?, ?, ?)`);

  const upsertMailStmt = db.prepare(`
    INSERT INTO mails (
      provider, account, message_id, external_id, provider_ref, mailbox, thread_id, thread_key,
      in_reply_to, references_header, from_text, to_text, cc_text, subject, snippet, body,
      body_text, body_html, body_text_preview, headers_json, received_at, archived_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, account, message_id)
    DO UPDATE SET
      external_id = excluded.external_id,
      provider_ref = excluded.provider_ref,
      mailbox = excluded.mailbox,
      thread_id = excluded.thread_id,
      thread_key = excluded.thread_key,
      in_reply_to = excluded.in_reply_to,
      references_header = excluded.references_header,
      from_text = excluded.from_text,
      to_text = excluded.to_text,
      cc_text = excluded.cc_text,
      subject = excluded.subject,
      snippet = excluded.snippet,
      body = excluded.body,
      body_text = excluded.body_text,
      body_html = excluded.body_html,
      body_text_preview = excluded.body_text_preview,
      headers_json = excluded.headers_json,
      received_at = excluded.received_at,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `);
  const deleteMailChunksStmt = db.prepare(`DELETE FROM mail_chunks WHERE mail_id = ?`);
  const insertMailChunkStmt = db.prepare(`INSERT INTO mail_chunks (mail_id, chunk_index, chunk_text, chunk_preview) VALUES (?, ?, ?, ?)`);

  const upsertMailsTx = db.transaction((mails) => {
    for (const mail of mails) {
      const row = upsertMailStmt.get(
        mail.provider,
        mail.account,
        mail.messageId,
        mail.id,
        mail.providerRef || "",
        mail.mailbox || "",
        mail.threadId || "",
        mail.threadKey || "",
        mail.inReplyTo || "",
        mail.referencesHeader || "",
        mail.from || "",
        mail.to || "",
        mail.cc || "",
        mail.subject || "",
        mail.snippet || "",
        mail.body || "",
        mail.bodyText || "",
        mail.bodyHtml || "",
        mail.bodyTextPreview || "",
        JSON.stringify(mail.headers || {}),
        mail.receivedAt,
      );

      deleteMailChunksStmt.run(row.id);
      const chunks = Array.isArray(mail.chunks) && mail.chunks.length ? mail.chunks : buildMailChunks(mail);
      for (const chunk of chunks) {
        insertMailChunkStmt.run(row.id, chunk.chunkIndex, chunk.text, chunk.preview || "");
      }
    }
  });

  const getMailStmt = db.prepare(`
    SELECT
      external_id AS id, provider, account, message_id AS messageId, provider_ref AS providerRef, mailbox,
      thread_id AS threadId, thread_key AS threadKey, in_reply_to AS inReplyTo, references_header AS referencesHeader,
      from_text AS sender, to_text AS recipient, cc_text AS cc, subject, snippet, body,
      body_text AS bodyText, body_html AS bodyHtml, body_text_preview AS bodyTextPreview,
      headers_json AS headersJson, received_at AS receivedAt, archived_at AS archivedAt, updated_at AS updatedAt
    FROM mails
    WHERE provider = ? AND account = ? AND message_id = ?
  `);

  const getThreadStmt = db.prepare(`
    SELECT
      external_id AS id, provider, account, message_id AS messageId, provider_ref AS providerRef, mailbox,
      thread_id AS threadId, thread_key AS threadKey, from_text AS sender, to_text AS recipient,
      cc_text AS cc, subject, snippet, body, body_text AS bodyText, body_html AS bodyHtml,
      body_text_preview AS bodyTextPreview, headers_json AS headersJson, received_at AS receivedAt
    FROM mails
    WHERE thread_key = ?
    ORDER BY datetime(received_at) ASC, id ASC
    LIMIT ?
  `);

  return {
    close() {
      db.close();
    },
    getCursor(provider, account, key) {
      return getCursorStmt.get(provider, account, key)?.value ?? null;
    },
    setCursor(provider, account, key, value) {
      setCursorStmt.run(provider, account, key, String(value));
    },
    hasSeen(provider, account, messageId) {
      return Boolean(hasSeenStmt.get(provider, account, messageId));
    },
    markSeen(provider, account, messageId) {
      markSeenStmt.run(provider, account, messageId);
    },
    upsertMail(mail) {
      upsertMailsTx([mail]);
    },
    upsertMails(mails) {
      if (!Array.isArray(mails) || !mails.length) {
        return;
      }
      upsertMailsTx(mails);
    },
    getMail(provider, account, messageId) {
      return getMailStmt.get(provider, account, messageId) ?? null;
    },
    getMailByCompositeId(id) {
      const parts = parseCompositeId(id);
      if (!parts) {
        return null;
      }
      return getMailStmt.get(parts.provider, parts.account, parts.messageId) ?? null;
    },
    getThreadByKey(threadKey, limit = 20) {
      return getThreadStmt.all(threadKey, limit);
    },
    listArchive(options = {}) {
      const limit = Math.max(1, Number(options.limit) || 20);
      const params = [];
      let sql = `
        SELECT
          external_id AS id, provider, account, message_id AS messageId, provider_ref AS providerRef, mailbox,
          thread_id AS threadId, thread_key AS threadKey, from_text AS sender, to_text AS recipient,
          cc_text AS cc, subject, snippet, body_text AS bodyText, body_html AS bodyHtml,
          body_text_preview AS bodyTextPreview, received_at AS receivedAt, archived_at AS archivedAt,
          updated_at AS updatedAt
        FROM mails
        WHERE 1 = 1
      `;

      if (options.provider) {
        sql += ` AND provider = ?`;
        params.push(options.provider);
      }
      if (options.account) {
        sql += ` AND account = ?`;
        params.push(options.account);
      }
      if (options.since) {
        sql += ` AND datetime(received_at) >= datetime(?)`;
        params.push(new Date(options.since).toISOString());
      }
      if (options.until) {
        sql += ` AND datetime(received_at) <= datetime(?)`;
        params.push(new Date(options.until).toISOString());
      }

      sql += ` ORDER BY datetime(received_at) DESC, id DESC LIMIT ?`;
      params.push(limit);
      return db.prepare(sql).all(...params);
    },
    searchArchive(options = {}) {
      const query = options.query || "";
      const limit = Math.max(1, Number(options.limit) || 8);
      const candidateMultiplier = Math.max(1, Number(options.candidateMultiplier) || 8);
      const tokens = tokenizeSearchQuery(query);

      if (!tokens.length) {
        return [];
      }

      const matchExpression = buildMatchExpression(tokens);
      const candidateLimit = limit * candidateMultiplier;
      const chunkParams = [matchExpression];
      let chunkSql = `
        SELECT
          mails.external_id, mails.provider, mails.account, mails.message_id, mails.thread_id, mails.thread_key,
          mails.from_text AS "from", mails.to_text AS "to", mails.cc_text AS cc, mails.subject, mails.snippet,
          mails.body, mails.body_text, mails.body_html, mails.body_text_preview, mails.received_at,
          mail_chunks.chunk_index, mail_chunks.chunk_text, mail_chunks.chunk_preview,
          bm25(mail_chunks_fts, 1.0) AS lexical_score
        FROM mail_chunks_fts
        JOIN mail_chunks ON mail_chunks.id = mail_chunks_fts.rowid
        JOIN mails ON mails.id = mail_chunks.mail_id
        WHERE mail_chunks_fts MATCH ?
      `;
      const messageParams = [matchExpression];
      let messageSql = `
        SELECT
          mails.external_id, mails.provider, mails.account, mails.message_id, mails.thread_id, mails.thread_key,
          mails.from_text AS "from", mails.to_text AS "to", mails.cc_text AS cc, mails.subject, mails.snippet,
          mails.body, mails.body_text, mails.body_html, mails.body_text_preview, mails.received_at,
          NULL AS chunk_index, NULL AS chunk_text, NULL AS chunk_preview,
          bm25(mails_fts, 1.5, 0.8, 0.4, 2.2, 1.2, 0.3) AS lexical_score
        FROM mails_fts
        JOIN mails ON mails.id = mails_fts.rowid
        WHERE mails_fts MATCH ?
      `;

      if (options.provider) {
        chunkSql += ` AND mails.provider = ?`;
        messageSql += ` AND mails.provider = ?`;
        chunkParams.push(options.provider);
        messageParams.push(options.provider);
      }
      if (options.account) {
        chunkSql += ` AND mails.account = ?`;
        messageSql += ` AND mails.account = ?`;
        chunkParams.push(options.account);
        messageParams.push(options.account);
      }
      if (options.since) {
        const since = new Date(options.since).toISOString();
        chunkSql += ` AND datetime(mails.received_at) >= datetime(?)`;
        messageSql += ` AND datetime(mails.received_at) >= datetime(?)`;
        chunkParams.push(since);
        messageParams.push(since);
      }
      if (options.until) {
        const until = new Date(options.until).toISOString();
        chunkSql += ` AND datetime(mails.received_at) <= datetime(?)`;
        messageSql += ` AND datetime(mails.received_at) <= datetime(?)`;
        chunkParams.push(until);
        messageParams.push(until);
      }

      chunkSql += ` ORDER BY lexical_score ASC, datetime(mails.received_at) DESC LIMIT ?`;
      messageSql += ` ORDER BY lexical_score ASC, datetime(mails.received_at) DESC LIMIT ?`;
      chunkParams.push(candidateLimit);
      messageParams.push(candidateLimit);

      const rows = [
        ...db.prepare(chunkSql).all(...chunkParams),
        ...db.prepare(messageSql).all(...messageParams),
      ];

      return rankSearchRows(rows, query, tokens, limit);
    },
  };
}
