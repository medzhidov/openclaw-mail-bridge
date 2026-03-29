import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true, quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false, quiet: true });

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toEnvKey(key, prefix) {
  return `${prefix}_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`;
}

function collectPrefixes(basePrefix) {
  const prefixes = new Set();

  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${basePrefix}_`)) {
      prefixes.add(basePrefix);
    }

    const match = key.match(new RegExp(`^(${basePrefix}_\d+)_`));
    if (match) {
      prefixes.add(match[1]);
    }
  }

  if (!prefixes.size) {
    prefixes.add(basePrefix);
  }

  return [...prefixes].sort((a, b) => {
    if (a === basePrefix) {
      return -1;
    }
    if (b === basePrefix) {
      return 1;
    }
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function loadGmailAccount(prefix) {
  return {
    prefix,
    enabled: parseBoolean(process.env[`${prefix}_ENABLED`], false),
    account: process.env[`${prefix}_ACCOUNT`] || "",
    clientId: process.env[`${prefix}_CLIENT_ID`] || "",
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || "",
    refreshToken: process.env[`${prefix}_REFRESH_TOKEN`] || "",
    label: process.env[`${prefix}_LABEL`] || "INBOX",
    maxScan: parseInteger(process.env[`${prefix}_MAX_SCAN`], 25),
  };
}

function loadYandexAccount(prefix) {
  return {
    prefix,
    enabled: parseBoolean(process.env[`${prefix}_ENABLED`], false),
    account: process.env[`${prefix}_ACCOUNT`] || "",
    username: process.env[`${prefix}_USERNAME`] || "",
    appPassword: process.env[`${prefix}_APP_PASSWORD`] || "",
    host: process.env[`${prefix}_IMAP_HOST`] || "imap.yandex.com",
    port: parseInteger(process.env[`${prefix}_IMAP_PORT`], 993),
    secure: parseBoolean(process.env[`${prefix}_IMAP_SECURE`], true),
    mailbox: process.env[`${prefix}_MAILBOX`] || "INBOX",
  };
}

export function loadConfig() {
  const cwd = process.cwd();
  const dbPath = path.resolve(cwd, process.env.DB_PATH || "./data/state.sqlite");

  return {
    cwd,
    dbPath,
    pollIntervalMs: parseInteger(process.env.POLL_INTERVAL_MS, 60_000),
    bootstrapMode: process.env.BOOTSTRAP_MODE || "skip-existing",
    logLevel: process.env.LOG_LEVEL || "info",
    openclaw: {
      hookUrl: process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/mail",
      hookToken: process.env.OPENCLAW_HOOK_TOKEN || "",
      deliveryEnabled: parseBoolean(process.env.OPENCLAW_DELIVERY_ENABLED, true),
      timeoutMs: parseInteger(process.env.OPENCLAW_DELIVERY_TIMEOUT_MS, 15_000),
    },
    archive: {
      bodyMaxChars: parseInteger(process.env.MAIL_BODY_MAX_CHARS, 50_000),
      htmlMaxChars: parseInteger(process.env.MAIL_HTML_MAX_CHARS, 200_000),
      backfillDefaultDays: parseInteger(process.env.BACKFILL_DEFAULT_DAYS, 365),
      batchSize: parseInteger(process.env.ARCHIVE_BATCH_SIZE, 100),
      gmailFetchConcurrency: parseInteger(process.env.GMAIL_FETCH_CONCURRENCY, 12),
      yandexParseConcurrency: parseInteger(process.env.YANDEX_PARSE_CONCURRENCY, 8),
      chunkSize: parseInteger(process.env.RETRIEVAL_CHUNK_SIZE, 900),
      chunkOverlap: parseInteger(process.env.RETRIEVAL_CHUNK_OVERLAP, 180),
      searchDefaultLimit: parseInteger(process.env.RETRIEVAL_DEFAULT_LIMIT, 8),
      candidateMultiplier: parseInteger(process.env.RETRIEVAL_CANDIDATE_MULTIPLIER, 8),
      threadPreviewLimit: parseInteger(process.env.RETRIEVAL_THREAD_PREVIEW_LIMIT, 20),
    },
    gmailAccounts: collectPrefixes("GMAIL").map(loadGmailAccount),
    yandexAccounts: collectPrefixes("YANDEX").map(loadYandexAccount),
  };
}

export function validateConfig(config) {
  const missing = [];

  if (!config.openclaw.hookUrl) {
    missing.push("OPENCLAW_HOOK_URL");
  }

  if (config.openclaw.deliveryEnabled && !config.openclaw.hookToken) {
    missing.push("OPENCLAW_HOOK_TOKEN");
  }

  for (const account of config.gmailAccounts) {
    if (account.enabled) {
      for (const key of ["account", "clientId", "clientSecret", "refreshToken"]) {
        if (!account[key]) {
          missing.push(toEnvKey(key, account.prefix));
        }
      }
    }
  }

  for (const account of config.yandexAccounts) {
    if (account.enabled) {
      for (const key of ["account", "username", "appPassword"]) {
        if (!account[key]) {
          missing.push(toEnvKey(key, account.prefix));
        }
      }
    }
  }

  if (!config.gmailAccounts.some((account) => account.enabled) && !config.yandexAccounts.some((account) => account.enabled)) {
    missing.push("At least one provider must be enabled: GMAIL_ENABLED=true or YANDEX_ENABLED=true");
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return missing;
}
