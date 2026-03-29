import process from "node:process";
import { loadConfig, validateConfig } from "./config.js";
import { createStateStore } from "./db.js";
import { createLogger } from "./logger.js";
import { deliverToOpenClaw } from "./openclaw.js";
import { GmailProvider } from "./providers/gmail.js";
import { YandexProvider } from "./providers/yandex.js";

function parseArgs(argv) {
  const tokens = [...argv.slice(2)];
  const args = {
    command: "run",
    once: false,
    doctor: false,
    provider: "",
    account: "",
    query: "",
    id: "",
    threadKey: "",
    since: "",
    until: "",
    days: null,
    limit: null,
    format: "both",
    includeMetadata: false,
  };
  const positionals = [];

  if (["backfill", "list", "today", "search", "message", "thread", "doctor"].includes(tokens[0])) {
    args.command = tokens.shift();
    if (args.command === "doctor") {
      args.doctor = true;
      args.command = "run";
    }
  }

  while (tokens.length) {
    const token = tokens.shift();
    switch (token) {
      case "--once":
        args.once = true;
        break;
      case "--doctor":
        args.doctor = true;
        break;
      case "--provider":
        args.provider = tokens.shift() || "";
        break;
      case "--account":
        args.account = tokens.shift() || "";
        break;
      case "--query":
        args.query = tokens.shift() || "";
        break;
      case "--id":
        args.id = tokens.shift() || "";
        break;
      case "--thread-key":
      case "--thread":
        args.threadKey = tokens.shift() || "";
        break;
      case "--since":
        args.since = tokens.shift() || "";
        break;
      case "--until":
        args.until = tokens.shift() || "";
        break;
      case "--days":
        args.days = Number.parseInt(tokens.shift() || "", 10);
        break;
      case "--limit":
        args.limit = Number.parseInt(tokens.shift() || "", 10);
        break;
      case "--format":
        args.format = tokens.shift() || "both";
        break;
      case "--include-metadata":
        args.includeMetadata = true;
        break;
      default:
        positionals.push(token);
    }
  }

  if (args.command === "search" && !args.query) {
    args.query = positionals.join(" ").trim();
  }
  if (args.command === "message" && !args.id) {
    args.id = positionals[0] || "";
  }
  if (args.command === "thread" && !args.threadKey) {
    args.threadKey = positionals[0] || "";
  }

  return args;
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveBackfillRange(args, config) {
  const until = parseDateInput(args.until) || new Date();
  const since = parseDateInput(args.since) || new Date(until.getTime() - (Math.max(1, args.days || config.archive.backfillDefaultDays) * 24 * 60 * 60 * 1000));
  return { since, until };
}
function resolveListRange(args) {
  if (args.command === "today") {
    const now = new Date();
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    return { since, until: now };
  }

  const until = parseDateInput(args.until) || null;
  const since = parseDateInput(args.since)
    || (args.days ? new Date((until || new Date()).getTime() - (Math.max(1, args.days) * 24 * 60 * 60 * 1000)) : null);
  return { since, until };
}

function selectProviders(providers, args) {
  return providers.filter((provider) => {
    if (args.provider && provider.providerName() !== args.provider) {
      return false;
    }
    if (args.account && provider.accountName() !== args.account) {
      return false;
    }
    return true;
  });
}

async function archiveMailBatch(store, mails) {
  store.upsertMails(mails);
}

function parseHeadersJson(headersJson) {
  try {
    return JSON.parse(headersJson || "{}");
  } catch {
    return {};
  }
}

function renderFormatPayload(message, format) {
  const normalized = String(format || "both").toLowerCase();
  if (normalized === "text") {
    return { format: "text", bodyText: message.bodyText || "" };
  }
  if (normalized === "html") {
    return { format: "html", bodyHtml: message.bodyHtml || "" };
  }
  return {
    format: "both",
    bodyText: message.bodyText || "",
    bodyHtml: message.bodyHtml || "",
  };
}

function renderMessageRecord(message, args) {
  if (!message) {
    return null;
  }

  const payload = renderFormatPayload(message, args.format);
  const result = {
    id: message.id,
    provider: message.provider,
    account: message.account,
    messageId: message.messageId,
    providerRef: message.providerRef,
    mailbox: message.mailbox,
    threadId: message.threadId,
    threadKey: message.threadKey,
    from: message.sender,
    to: message.recipient,
    cc: message.cc,
    subject: message.subject,
    snippet: message.snippet,
    bodyTextPreview: message.bodyTextPreview,
    receivedAt: message.receivedAt,
    archivedAt: message.archivedAt,
    updatedAt: message.updatedAt,
    availableFormats: {
      text: Boolean(message.bodyText),
      html: Boolean(message.bodyHtml),
    },
    ...payload,
  };

  if (args.includeMetadata) {
    result.headers = parseHeadersJson(message.headersJson);
    result.referencesHeader = message.referencesHeader;
    result.inReplyTo = message.inReplyTo;
  }

  return result;
}
function renderListRecord(message) {
  if (!message) {
    return null;
  }

  return {
    id: message.id,
    provider: message.provider,
    account: message.account,
    messageId: message.messageId,
    providerRef: message.providerRef,
    mailbox: message.mailbox,
    threadId: message.threadId,
    threadKey: message.threadKey,
    from: message.sender,
    to: message.recipient,
    cc: message.cc,
    subject: message.subject,
    snippet: message.snippet,
    bodyTextPreview: message.bodyTextPreview,
    receivedAt: message.receivedAt,
    archivedAt: message.archivedAt,
    updatedAt: message.updatedAt,
    availableFormats: {
      text: Boolean(message.bodyText),
      html: Boolean(message.bodyHtml),
    },
  };
}

async function runCycle(providers, store, config, logger) {
  for (const provider of providers) {
    const mails = await provider.poll();
    await archiveMailBatch(store, mails);

    for (const mail of mails) {
      await deliverToOpenClaw(config, logger, mail);
      store.markSeen(mail.provider, mail.account, mail.messageId);
      logger.info(`Delivered ${mail.id}`);
    }
  }
}

async function runBackfill(providers, store, config, args) {
  const selectedProviders = selectProviders(providers, args);
  const range = resolveBackfillRange(args, config);
  const summary = { since: range.since.toISOString(), until: range.until.toISOString(), providers: [] };

  for (const provider of selectedProviders) {
    const result = await provider.backfill({
      ...range,
      onMail: async (mails) => {
        await archiveMailBatch(store, mails);
      },
    });

    summary.providers.push({ provider: provider.providerName(), account: provider.accountName(), archived: result.archived });
  }

  console.log(JSON.stringify(summary, null, 2));
}

function runSearch(store, config, args) {
  if (!args.query) {
    throw new Error('Search query is required. Use: node src/index.js search --query "..."');
  }

  const results = store.searchArchive({
    query: args.query,
    provider: args.provider || undefined,
    account: args.account || undefined,
    since: args.since || undefined,
    until: args.until || undefined,
    limit: args.limit || config.archive.searchDefaultLimit,
    candidateMultiplier: config.archive.candidateMultiplier,
  });

  console.log(JSON.stringify({ query: args.query, count: results.length, results }, null, 2));
}
function runListLookup(store, config, args) {
  const range = resolveListRange(args);
  const results = store.listArchive({
    provider: args.provider || undefined,
    account: args.account || undefined,
    since: range.since?.toISOString(),
    until: range.until?.toISOString(),
    limit: args.limit || Math.max(20, config.archive.threadPreviewLimit),
  });

  console.log(JSON.stringify({
    mode: args.command,
    since: range.since?.toISOString() || null,
    until: range.until?.toISOString() || null,
    count: results.length,
    messages: results.map(renderListRecord),
  }, null, 2));
}

function runMessageLookup(store, args) {
  if (!args.id) {
    throw new Error("Message id is required. Use: node src/index.js message --id provider:account:message-id");
  }

  const message = store.getMailByCompositeId(args.id);
  console.log(JSON.stringify(renderMessageRecord(message, args), null, 2));
}

function runThreadLookup(store, config, args) {
  if (!args.threadKey && !args.id) {
    throw new Error("Thread key or message id is required. Use: node src/index.js thread --thread-key ...");
  }

  const message = args.id ? store.getMailByCompositeId(args.id) : null;
  const threadKey = args.threadKey || message?.threadKey || "";
  if (!threadKey) {
    console.log(JSON.stringify([], null, 2));
    return;
  }

  const thread = store.getThreadByKey(threadKey, args.limit || config.archive.threadPreviewLimit);
  console.log(JSON.stringify({
    threadKey,
    count: thread.length,
    messages: thread.map((item) => renderMessageRecord(item, args)),
  }, null, 2));
}

function getMissingConfigForCommand(missing, args) {
  if (args.doctor) {
    return missing;
  }
  if (args.command === "backfill") {
    return missing.filter((item) => item !== "OPENCLAW_HOOK_TOKEN");
  }
  if (["list", "today", "search", "message", "thread"].includes(args.command)) {
    return [];
  }
  return missing;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const missing = getMissingConfigForCommand(validateConfig(config), args);

  if (args.doctor) {
    if (!missing.length) {
      logger.info("Config looks ready.");
      return;
    }
    logger.warn("Missing configuration:");
    for (const item of missing) {
      logger.warn(`- ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  if (missing.length) {
    logger.error("Configuration is incomplete:");
    for (const item of missing) {
      logger.error(`- ${item}`);
    }
    process.exit(1);
  }

  const store = createStateStore(config.dbPath);
  const providers = [];
  for (const account of config.gmailAccounts) {
    if (account.enabled) {
      providers.push(new GmailProvider(account, store, logger, config.archive));
    }
  }
  for (const account of config.yandexAccounts) {
    if (account.enabled) {
      providers.push(new YandexProvider(account, store, logger, config.archive));
    }
  }

  const shutdown = () => {
    logger.info("Shutting down");
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (args.command === "backfill") {
    await runBackfill(providers, store, config, args);
    store.close();
    return;
  }
  if (args.command === "list" || args.command === "today") {
    runListLookup(store, config, args);
    store.close();
    return;
  }
  if (args.command === "search") {
    runSearch(store, config, args);
    store.close();
    return;
  }
  if (args.command === "message") {
    runMessageLookup(store, args);
    store.close();
    return;
  }
  if (args.command === "thread") {
    runThreadLookup(store, config, args);
    store.close();
    return;
  }

  await runCycle(providers, store, config, logger);
  if (args.once) {
    store.close();
    return;
  }

  logger.info(`Mail bridge running with poll interval ${config.pollIntervalMs}ms`);
  setInterval(() => {
    runCycle(providers, store, config, logger).catch((error) => {
      logger.error("Poll cycle failed", error);
    });
  }, config.pollIntervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
