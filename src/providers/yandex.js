import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { finalizeMailRecord } from "../mail.js";

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function parsedHeaders(parsed) {
  return Object.fromEntries((parsed.headerLines || []).map((header) => [String(header.key || "").toLowerCase(), String(header.line || "").replace(/^.*?:\s*/, "")]));
}

export class YandexProvider {
  constructor(accountConfig, store, logger, archiveConfig = {}) {
    this.account = accountConfig;
    this.store = store;
    this.logger = logger;
    this.archiveConfig = archiveConfig;
  }

  providerName() {
    return "yandex";
  }

  accountName() {
    return this.account.account;
  }

  async toMailRecord(message) {
    const parsed = await simpleParser(message.source);
    const messageId = parsed.messageId || `uid-${message.uid}`;

    return finalizeMailRecord({
      provider: this.providerName(),
      account: this.accountName(),
      providerRef: String(message.uid || ""),
      mailbox: this.account.mailbox,
      messageId,
      threadId: "",
      from: parsed.from?.text || "",
      to: parsed.to?.text || "",
      cc: parsed.cc?.text || "",
      subject: parsed.subject || "",
      snippet: (parsed.text || parsed.html || "").trim().replace(/\s+/g, " ").slice(0, 500),
      bodyText: parsed.text || "",
      bodyHtml: typeof parsed.html === "string" ? parsed.html : "",
      inReplyTo: parsed.inReplyTo || "",
      referencesHeader: parsed.references || "",
      headers: parsedHeaders(parsed),
      receivedAt: (message.internalDate || new Date()).toISOString(),
    }, this.archiveConfig);
  }

  async withClient(fn) {
    const client = new ImapFlow({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.secure,
      logger: false,
      auth: {
        user: this.account.username,
        pass: this.account.appPassword,
      },
    });

    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async initializeBaseline() {
    const existing = this.store.getCursor(this.providerName(), this.accountName(), "lastUid");
    const existingValidity = this.store.getCursor(this.providerName(), this.accountName(), "uidValidity");
    if (existing !== null && existingValidity !== null) {
      return;
    }

    await this.withClient(async (client) => {
      await client.mailboxOpen(this.account.mailbox);
      const uidNext = client.mailbox.uidNext || 1;
      const uidValidity = client.mailbox.uidValidity || 0;
      this.store.setCursor(this.providerName(), this.accountName(), "lastUid", Math.max(uidNext - 1, 0));
      this.store.setCursor(this.providerName(), this.accountName(), "uidValidity", uidValidity);
      this.logger.info(`Yandex baseline initialized at uid=${Math.max(uidNext - 1, 0)} uidValidity=${uidValidity}`);
    });
  }

  async poll() {
    await this.initializeBaseline();

    return this.withClient(async (client) => {
      await client.mailboxOpen(this.account.mailbox);

      const currentValidity = String(client.mailbox.uidValidity || 0);
      const storedValidity = this.store.getCursor(this.providerName(), this.accountName(), "uidValidity");
      if (storedValidity !== currentValidity) {
        const uidNext = client.mailbox.uidNext || 1;
        this.store.setCursor(this.providerName(), this.accountName(), "uidValidity", currentValidity);
        this.store.setCursor(this.providerName(), this.accountName(), "lastUid", Math.max(uidNext - 1, 0));
        this.logger.warn("Yandex uidValidity changed; resetting baseline and skipping old mail");
        return [];
      }

      const lastUid = Number(this.store.getCursor(this.providerName(), this.accountName(), "lastUid") || "0");
      const nextRangeStart = lastUid + 1;
      const results = [];
      let maxUid = lastUid;
      const pending = [];

      const flushPending = async () => {
        if (!pending.length) {
          return;
        }
        const fetched = pending.splice(0, pending.length);
        const records = await mapWithConcurrency(fetched, this.archiveConfig.yandexParseConcurrency || 4, (item) => this.toMailRecord(item));
        for (const record of records) {
          if (this.store.hasSeen(this.providerName(), this.accountName(), record.messageId)) {
            continue;
          }
          results.push(record);
        }
      };

      for await (const message of client.fetch(`${nextRangeStart}:*`, { uid: true, internalDate: true, source: true })) {
        maxUid = Math.max(maxUid, message.uid || 0);
        pending.push(message);
        if (pending.length >= (this.archiveConfig.batchSize || 50)) {
          await flushPending();
        }
      }

      await flushPending();
      this.store.setCursor(this.providerName(), this.accountName(), "lastUid", maxUid);
      return results;
    });
  }

  async backfill({ since, until, onMail }) {
    return this.withClient(async (client) => {
      await client.mailboxOpen(this.account.mailbox);
      const criteria = {};
      if (since) {
        criteria.since = since;
      }
      if (until) {
        criteria.before = until;
      }

      const search = Object.keys(criteria).length ? criteria : "1:*";
      let archived = 0;
      const pending = [];

      const flushPending = async () => {
        if (!pending.length) {
          return;
        }
        const fetched = pending.splice(0, pending.length);
        const records = await mapWithConcurrency(fetched, this.archiveConfig.yandexParseConcurrency || 8, (item) => this.toMailRecord(item));
        await onMail(records);
        archived += records.length;
      };

      for await (const message of client.fetch(search, { uid: true, internalDate: true, source: true })) {
        pending.push(message);
        if (pending.length >= (this.archiveConfig.batchSize || 100)) {
          await flushPending();
        }
      }

      await flushPending();
      return { archived };
    });
  }
}
