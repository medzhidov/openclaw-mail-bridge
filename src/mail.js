function truncateText(input, maxChars) {
  if (!input) {
    return "";
  }

  const text = String(input).trim();
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars);
}

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function htmlToText(input) {
  if (!input) {
    return "";
  }

  return decodeHtmlEntities(
    String(input)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeWhitespace(input) {
  return String(input || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractReferenceIds(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractReferenceIds(item));
  }

  const matches = String(value).match(/<[^>]+>/g);
  if (matches?.length) {
    return matches;
  }

  return String(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeThreadSubject(subject) {
  if (!subject) {
    return "";
  }

  let normalized = String(subject).toLowerCase().replace(/\s+/g, " ").trim();

  while (/^(re|fw|fwd)\s*:/i.test(normalized)) {
    normalized = normalized.replace(/^(re|fw|fwd)\s*:/i, "").trim();
  }

  return normalized;
}

function buildThreadKey(mail) {
  if (mail.threadId) {
    return `${mail.provider}:${mail.account}:thread:${mail.threadId}`;
  }

  const references = extractReferenceIds(mail.referencesHeader);
  const rootReference = references[0] || mail.inReplyTo || "";
  if (rootReference) {
    return `${mail.provider}:${mail.account}:ref:${rootReference}`;
  }

  const subjectKey = normalizeThreadSubject(mail.subject);
  if (subjectKey) {
    return `${mail.provider}:${mail.account}:subject:${subjectKey}`;
  }

  return `${mail.provider}:${mail.account}:message:${mail.messageId}`;
}

function buildPreviewText({ snippet, bodyText, bodyHtml }, maxChars) {
  const source = normalizeWhitespace(snippet || bodyText || htmlToText(bodyHtml));
  return truncateText(source, maxChars);
}

export function buildMailChunks(mail, options = {}) {
  const chunkSize = options.chunkSize ?? 900;
  const chunkOverlap = options.chunkOverlap ?? 180;
  const previewSize = options.previewSize ?? 320;
  const text = normalizeWhitespace(mail.bodyText || htmlToText(mail.bodyHtml) || mail.snippet);

  if (!text) {
    return [];
  }

  const chunks = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const slice = text.slice(offset, offset + chunkSize);
    const normalized = normalizeWhitespace(slice);
    if (normalized) {
      chunks.push({
        chunkIndex: index,
        text: normalized,
        preview: truncateText(normalized, previewSize),
      });
      index += 1;
    }

    if (offset + chunkSize >= text.length) {
      break;
    }

    offset += Math.max(1, chunkSize - chunkOverlap);
  }

  return chunks;
}

export function finalizeMailRecord(mail, options = {}) {
  const bodyMaxChars = options.bodyMaxChars ?? 50_000;
  const htmlMaxChars = options.htmlMaxChars ?? 200_000;
  const snippetMaxChars = options.snippetMaxChars ?? 1_000;
  const previewMaxChars = options.previewMaxChars ?? 1_200;
  const referencesHeader = extractReferenceIds(mail.referencesHeader).join(" ");
  const inReplyTo = mail.inReplyTo ? String(mail.inReplyTo).trim() : "";
  const receivedAt = new Date(mail.receivedAt || Date.now());
  const bodyText = normalizeWhitespace(mail.bodyText || mail.body || htmlToText(mail.bodyHtml));
  const bodyHtml = truncateText(mail.bodyHtml, htmlMaxChars);
  const snippet = buildPreviewText({ snippet: mail.snippet, bodyText, bodyHtml }, snippetMaxChars);
  const bodyTextPreview = buildPreviewText({ snippet, bodyText, bodyHtml }, previewMaxChars);
  const headers = mail.headers && typeof mail.headers === "object" ? mail.headers : {};

  const record = {
    provider: mail.provider,
    account: mail.account,
    messageId: String(mail.messageId || "").trim(),
    providerRef: mail.providerRef ? String(mail.providerRef).trim() : "",
    mailbox: mail.mailbox ? String(mail.mailbox).trim() : "",
    threadId: mail.threadId ? String(mail.threadId).trim() : "",
    from: truncateText(mail.from, 2_000),
    to: truncateText(mail.to, 2_000),
    cc: truncateText(mail.cc, 2_000),
    subject: truncateText(mail.subject, 2_000),
    snippet,
    body: truncateText(bodyText || bodyTextPreview, bodyMaxChars),
    bodyText: truncateText(bodyText, bodyMaxChars),
    bodyHtml,
    bodyTextPreview,
    inReplyTo,
    referencesHeader,
    headers,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : receivedAt.toISOString(),
  };

  if (!record.messageId) {
    throw new Error(`Mail record is missing messageId for ${record.provider}:${record.account}`);
  }

  return {
    ...record,
    id: `${record.provider}:${record.account}:${record.messageId}`,
    threadKey: buildThreadKey(record),
    chunks: buildMailChunks(record, options),
  };
}

export function composeGmailBackfillQuery({ since, until }) {
  const parts = [];

  if (since instanceof Date && !Number.isNaN(since.getTime())) {
    parts.push(`after:${Math.floor(since.getTime() / 1000)}`);
  }

  if (until instanceof Date && !Number.isNaN(until.getTime())) {
    parts.push(`before:${Math.floor(until.getTime() / 1000)}`);
  }

  return parts.join(" ").trim();
}
