import { google } from "googleapis";
import { composeGmailBackfillQuery, finalizeMailRecord } from "../mail.js";

function decodeBase64Url(input) {
  if (!input) {
    return "";
  }

  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectBodies(payload, acc = { text: [], html: [] }) {
  if (!payload) {
    return acc;
  }

  const mimeType = String(payload.mimeType || "").toLowerCase();
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (mimeType === "text/plain") {
      acc.text.push(decoded);
    } else if (mimeType === "text/html") {
      acc.html.push(decoded);
    }
  }

  for (const part of payload.parts || []) {
    collectBodies(part, acc);
  }

  return acc;
}

function headerValue(headers, name) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function headerMap(headers) {
  return Object.fromEntries((headers || []).map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
}

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

export class GmailProvider {
  constructor(accountConfig, store, logger, archiveConfig = {}) {
    this.account = accountConfig;
    this.store = store;
    this.logger = logger;
    this.archiveConfig = archiveConfig;

    const auth = new google.auth.OAuth2(this.account.clientId, this.account.clientSecret);
    auth.setCredentials({ refresh_token: this.account.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  providerName() {
    return "gmail";
  }

  accountName() {
    return this.account.account;
  }

  async getMessageRecord(id) {
    const message = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    const internalDateMs = Number(message.data.internalDate || "0");
    const payload = message.data.payload;
    const headers = payload?.headers || [];
    const bodies = collectBodies(payload);
    const messageId = headerValue(headers, "Message-ID") || message.data.id;

    return finalizeMailRecord({
      provider: this.providerName(),
      account: this.accountName(),
      providerRef: message.data.id || id,
      mailbox: this.account.label || "INBOX",
      messageId,
      threadId: message.data.threadId || "",
      from: headerValue(headers, "From"),
      to: headerValue(headers, "To"),
      cc: headerValue(headers, "Cc"),
      subject: headerValue(headers, "Subject"),
      snippet: message.data.snippet || "",
      bodyText: bodies.text.join("\\n\\n"),
      bodyHtml: bodies.html.join("\\n\\n"),
      inReplyTo: headerValue(headers, "In-Reply-To"),
      referencesHeader: headerValue(headers, "References"),
      headers: headerMap(headers),
      receivedAt: new Date(internalDateMs || Date.now()).toISOString(),
    }, this.archiveConfig);
  }

  async initializeBaseline() {
    const existing = this.store.getCursor(this.providerName(), this.accountName(), "historyId");
    if (existing !== null) {
      return;
    }

    const profile = await this.gmail.users.getProfile({ userId: "me" });
    const historyId = profile.data.historyId || "0";
    this.store.setCursor(this.providerName(), this.accountName(), "historyId", historyId);
    this.logger.info(`Gmail baseline initialized at historyId=${historyId}`);
  }

  async poll() {
    await this.initializeBaseline();
    const previousHistoryId = this.store.getCursor(this.providerName(), this.accountName(), "historyId") || "0";
    const results = [];
    const messageIds = new Set();
    let pageToken;
    let latestHistoryId = previousHistoryId;

    try {
      do {
        const response = await this.gmail.users.history.list({
          userId: "me",
          startHistoryId: previousHistoryId,
          historyTypes: ["messageAdded"],
          labelId: this.account.label,
          pageToken,
          maxResults: this.account.maxScan,
        });

        latestHistoryId = response.data.historyId || latestHistoryId;
        pageToken = response.data.nextPageToken || undefined;

        for (const entry of response.data.history || []) {
          for (const added of entry.messagesAdded || []) {
            if (added.message?.id) {
              messageIds.add(added.message.id);
            }
          }
        }
      } while (pageToken);
    } catch (error) {
      if (error?.code === 404) {
        const profile = await this.gmail.users.getProfile({ userId: "me" });
        const historyId = profile.data.historyId || previousHistoryId;
        this.store.setCursor(this.providerName(), this.accountName(), "historyId", historyId);
        this.logger.warn("Gmail history cursor expired; baseline reset to current historyId");
        return [];
      }

      throw error;
    }

    const records = await mapWithConcurrency([...messageIds], this.archiveConfig.gmailFetchConcurrency || 6, (id) => this.getMessageRecord(id));
    for (const record of records) {
      if (!record) {
        continue;
      }
      if (this.store.hasSeen(this.providerName(), this.accountName(), record.messageId)) {
        continue;
      }
      results.push(record);
    }

    this.store.setCursor(this.providerName(), this.accountName(), "historyId", latestHistoryId);
    return results;
  }

  async backfill({ since, until, onMail }) {
    let pageToken;
    let archived = 0;
    const query = composeGmailBackfillQuery({ since, until });

    do {
      const response = await this.gmail.users.messages.list({
        userId: "me",
        labelIds: this.account.label ? [this.account.label] : undefined,
        q: query || undefined,
        maxResults: 250,
        pageToken,
      });

      pageToken = response.data.nextPageToken || undefined;
      const ids = (response.data.messages || []).map((message) => message.id).filter(Boolean);
      if (!ids.length) {
        continue;
      }

      const records = await mapWithConcurrency(ids, this.archiveConfig.gmailFetchConcurrency || 12, (id) => this.getMessageRecord(id));
      const batch = records.filter(Boolean);
      if (batch.length) {
        await onMail(batch);
        archived += batch.length;
      }
    } while (pageToken);

    return { archived };
  }
}
