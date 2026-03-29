import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { loadConfig, validateConfig } from "./config.js";
import { createStateStore } from "./db.js";

function parseHeadersJson(headersJson) {
  try {
    return JSON.parse(headersJson || "{}");
  } catch {
    return {};
  }
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveListRange(args = {}) {
  if (args.today) {
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

function renderMessageRecord(message, options = {}) {
  if (!message) {
    return null;
  }

  const payload = renderFormatPayload(message, options.format);
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

  if (options.includeMetadata) {
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

function buildAccountGroups(messages) {
  const groups = new Map();

  for (const message of messages) {
    const key = `${message.provider}\u0000${message.account}`;
    if (!groups.has(key)) {
      groups.set(key, {
        provider: message.provider,
        account: message.account,
        count: 0,
        latestReceivedAt: message.receivedAt || "",
        messages: [],
      });
    }

    const group = groups.get(key);
    group.count += 1;
    if ((message.receivedAt || "") > group.latestReceivedAt) {
      group.latestReceivedAt = message.receivedAt || "";
    }
    group.messages.push(renderListRecord(message));
  }

  return [...groups.values()]
    .sort((a, b) => b.latestReceivedAt.localeCompare(a.latestReceivedAt) || a.provider.localeCompare(b.provider) || a.account.localeCompare(b.account))
    .map(({ latestReceivedAt, ...group }) => group);
}

function resolvePerAccountLimit({ account, limit, perAccountLimit, defaultLimit }) {
  const normalizedPerAccountLimit = Number(perAccountLimit) || null;
  if (normalizedPerAccountLimit) {
    return normalizedPerAccountLimit;
  }

  if (!account) {
    return Math.max(1, Number(limit) || defaultLimit);
  }

  return null;
}

function renderListPayload({ mode, since, until, messages, perAccountLimit }) {
  const renderedMessages = messages.map(renderListRecord);
  const payload = {
    mode,
    since: since || null,
    until: until || null,
    grouping: perAccountLimit ? "per_account" : "global",
    count: renderedMessages.length,
  };

  if (perAccountLimit) {
    payload.perAccountLimit = perAccountLimit;
    payload.accounts = buildAccountGroups(messages);
    payload.accountCount = payload.accounts.length;
  } else {
    payload.messages = renderedMessages;
  }

  return payload;
}

function renderListToolText(payload) {
  if (!payload) {
    return "";
  }

  if (payload.grouping === "per_account") {
    const lines = [
      `mode: ${payload.mode}`,
      `grouping: per_account`,
      `perAccountLimit: ${payload.perAccountLimit}`,
      `accountCount: ${payload.accountCount}`,
      `messageCount: ${payload.count}`,
      "",
    ];

    for (const account of payload.accounts || []) {
      lines.push(`${account.provider} / ${account.account}`);
      for (const message of account.messages || []) {
        lines.push(`- ${message.receivedAt} | ${message.provider}/${message.account} | ${message.mailbox || ""} | ${message.from} | ${message.subject}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  const lines = [
    `mode: ${payload.mode}`,
    `grouping: global`,
    `messageCount: ${payload.count}`,
    "",
  ];
  for (const message of payload.messages || []) {
    lines.push(`- ${message.receivedAt} | ${message.provider}/${message.account} | ${message.mailbox || ""} | ${message.from} | ${message.subject}`);
  }
  return lines.join("\n").trim();
}

function renderSearchToolText(payload) {
  const lines = [
    `query: ${payload.query}`,
    `count: ${payload.count}`,
    "",
  ];

  for (const result of payload.results || []) {
    lines.push(`- ${result.receivedAt} | ${result.provider}/${result.account} | ${result.mailbox || ""} | ${result.from} | ${result.subject}`);
  }

  return lines.join("\n").trim();
}

function renderMessageToolText(message) {
  if (!message) {
    return "not found";
  }

  return [
    `id: ${message.id}`,
    `provider: ${message.provider}`,
    `account: ${message.account}`,
    `mailbox: ${message.mailbox}`,
    `receivedAt: ${message.receivedAt}`,
    `from: ${message.from}`,
    `to: ${message.to}`,
    `subject: ${message.subject}`,
    "",
    message.bodyText || message.bodyHtml || message.snippet || "",
  ].join("\n").trim();
}

function renderThreadToolText(payload) {
  const lines = [
    `threadKey: ${payload.threadKey || ""}`,
    `count: ${payload.count}`,
    "",
  ];

  for (const message of payload.messages || []) {
    lines.push(`- ${message.receivedAt} | ${message.provider}/${message.account} | ${message.mailbox || ""} | ${message.from} | ${message.subject}`);
  }

  return lines.join("\n").trim();
}

function toToolResult(payload, text = null) {
  return {
    content: [{ type: "text", text: text || JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

const config = loadConfig();
const missing = validateConfig(config).filter((item) => item !== "OPENCLAW_HOOK_TOKEN");
if (missing.length) {
  console.error("MCP server configuration is incomplete:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

const store = createStateStore(config.dbPath);
const server = new McpServer(
  {
    name: "openclaw-mail-bridge",
    version: "0.1.0",
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

server.registerTool(
  "mail_today",
  {
    title: "List today's mail",
    description: "List archived messages received today. Use this for date-based overviews instead of keyword search.",
    inputSchema: z.object({
      provider: z.string().optional().describe("Optional provider filter, for example gmail or yandex."),
      account: z.string().optional().describe("Optional account filter."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of messages to return. If account is omitted, this limit is applied per mailbox. Default is 20."),
      perAccountLimit: z.number().int().min(1).max(50).optional().describe("Optional explicit per-account cap. Usually you can omit this because mail_today defaults to per-mailbox mode when account is not specified."),
    }),
  },
  async ({ provider, account, limit, perAccountLimit }) => {
    const range = resolveListRange({ today: true });
    const effectivePerAccountLimit = resolvePerAccountLimit({ account, limit, perAccountLimit, defaultLimit: 20 });
    const messages = effectivePerAccountLimit
      ? store.listArchiveByAccount({
        provider,
        account,
        since: range.since?.toISOString(),
        until: range.until?.toISOString(),
        perAccountLimit: effectivePerAccountLimit,
      })
      : store.listArchive({
        provider,
        account,
        since: range.since?.toISOString(),
        until: range.until?.toISOString(),
        limit: limit || 20,
      });

    const payload = renderListPayload({
      mode: "today",
      since: range.since?.toISOString() || null,
      until: range.until?.toISOString() || null,
      messages,
      perAccountLimit: effectivePerAccountLimit,
    });
    return toToolResult(payload, renderListToolText(payload));
  },
);

server.registerTool(
  "mail_list",
  {
    title: "List mail for a date range",
    description: "List archived messages for a specific time range without using keyword search.",
    inputSchema: z.object({
      provider: z.string().optional().describe("Optional provider filter, for example gmail or yandex."),
      account: z.string().optional().describe("Optional account filter."),
      since: z.string().optional().describe("Optional ISO datetime lower bound."),
      until: z.string().optional().describe("Optional ISO datetime upper bound."),
      days: z.number().int().min(1).max(3650).optional().describe("Optional relative range in days if since is not provided."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of messages to return. If account is omitted, this limit is applied per mailbox. Default is 20."),
      perAccountLimit: z.number().int().min(1).max(50).optional().describe("Optional explicit per-account cap. Usually you can omit this because mail_list defaults to per-mailbox mode when account is not specified."),
    }),
  },
  async ({ provider, account, since, until, days, limit, perAccountLimit }) => {
    const range = resolveListRange({ since, until, days });
    const effectivePerAccountLimit = resolvePerAccountLimit({ account, limit, perAccountLimit, defaultLimit: 20 });
    const messages = effectivePerAccountLimit
      ? store.listArchiveByAccount({
        provider,
        account,
        since: range.since?.toISOString(),
        until: range.until?.toISOString(),
        perAccountLimit: effectivePerAccountLimit,
      })
      : store.listArchive({
        provider,
        account,
        since: range.since?.toISOString(),
        until: range.until?.toISOString(),
        limit: limit || 20,
      });

    const payload = renderListPayload({
      mode: "list",
      since: range.since?.toISOString() || null,
      until: range.until?.toISOString() || null,
      messages,
      perAccountLimit: effectivePerAccountLimit,
    });
    return toToolResult(payload, renderListToolText(payload));
  },
);

server.registerTool(
  "mail_search",
  {
    title: "Search mail archive",
    description: "Keyword and topic search over the local mail archive with optional provider, account, and date filters.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query, for example 'clickup login' or 'invoice from alice'."),
      provider: z.string().optional().describe("Optional provider filter, for example gmail or yandex."),
      account: z.string().optional().describe("Optional account filter."),
      since: z.string().optional().describe("Optional ISO datetime lower bound."),
      until: z.string().optional().describe("Optional ISO datetime upper bound."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of ranked results to return. Default comes from service config."),
    }),
  },
  async ({ query, provider, account, since, until, limit }) => {
    const results = store.searchArchive({
      query,
      provider,
      account,
      since,
      until,
      limit: limit || config.archive.searchDefaultLimit,
      candidateMultiplier: config.archive.candidateMultiplier,
    });

    const payload = {
      query,
      count: results.length,
      results,
    };
    return toToolResult(payload, renderSearchToolText(payload));
  },
);

server.registerTool(
  "mail_message",
  {
    title: "Open a single message",
    description: "Fetch one archived message by composite id and return text, html, or both, with optional metadata.",
    inputSchema: z.object({
      id: z.string().min(1).describe("Composite message id in the form provider:account:message-id."),
      format: z.enum(["text", "html", "both"]).optional().describe("Which body format to return. Default is both."),
      includeMetadata: z.boolean().optional().describe("Include headers, references, and reply metadata."),
    }),
  },
  async ({ id, format, includeMetadata }) => {
    const message = store.getMailByCompositeId(id);
    const payload = renderMessageRecord(message, { format: format || "both", includeMetadata: Boolean(includeMetadata) });
    return toToolResult(payload, renderMessageToolText(payload));
  },
);

server.registerTool(
  "mail_thread",
  {
    title: "Open a thread",
    description: "Fetch a thread by threadKey or by starting from a specific message id.",
    inputSchema: z.object({
      id: z.string().optional().describe("Optional composite message id to resolve the thread key from."),
      threadKey: z.string().optional().describe("Optional explicit thread key."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of thread messages to return."),
      format: z.enum(["text", "html", "both"]).optional().describe("Which body format to return for each message. Default is both."),
      includeMetadata: z.boolean().optional().describe("Include headers, references, and reply metadata."),
    }).refine((value) => Boolean(value.id || value.threadKey), {
      message: "Either id or threadKey is required.",
    }),
  },
  async ({ id, threadKey, limit, format, includeMetadata }) => {
    const baseMessage = id ? store.getMailByCompositeId(id) : null;
    const resolvedThreadKey = threadKey || baseMessage?.threadKey || "";
    const thread = resolvedThreadKey
      ? store.getThreadByKey(resolvedThreadKey, limit || config.archive.threadPreviewLimit)
      : [];

    const payload = {
      threadKey: resolvedThreadKey || null,
      count: thread.length,
      messages: thread.map((message) => renderMessageRecord(message, { format: format || "both", includeMetadata: Boolean(includeMetadata) })),
    };
    return toToolResult(payload, renderThreadToolText(payload));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openclaw-mail-bridge MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  store.close();
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
