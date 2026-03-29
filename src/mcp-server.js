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

function toToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of messages to return. Default is 20."),
    }),
  },
  async ({ provider, account, limit }) => {
    const range = resolveListRange({ today: true });
    const messages = store.listArchive({
      provider,
      account,
      since: range.since?.toISOString(),
      until: range.until?.toISOString(),
      limit: limit || 20,
    }).map(renderListRecord);

    return toToolResult({
      mode: "today",
      since: range.since?.toISOString() || null,
      until: range.until?.toISOString() || null,
      count: messages.length,
      messages,
    });
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
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of messages to return. Default is 20."),
    }),
  },
  async ({ provider, account, since, until, days, limit }) => {
    const range = resolveListRange({ since, until, days });
    const messages = store.listArchive({
      provider,
      account,
      since: range.since?.toISOString(),
      until: range.until?.toISOString(),
      limit: limit || 20,
    }).map(renderListRecord);

    return toToolResult({
      mode: "list",
      since: range.since?.toISOString() || null,
      until: range.until?.toISOString() || null,
      count: messages.length,
      messages,
    });
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

    return toToolResult({
      query,
      count: results.length,
      results,
    });
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
    return toToolResult(renderMessageRecord(message, { format: format || "both", includeMetadata: Boolean(includeMetadata) }));
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

    return toToolResult({
      threadKey: resolvedThreadKey || null,
      count: thread.length,
      messages: thread.map((message) => renderMessageRecord(message, { format: format || "both", includeMetadata: Boolean(includeMetadata) })),
    });
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
