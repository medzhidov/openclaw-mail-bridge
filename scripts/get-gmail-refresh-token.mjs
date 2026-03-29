import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { google } from "googleapis";
import dotenv from "dotenv";

const projectDir = path.resolve("/Users/ilia/Documents/projects/openclaw-mail-bridge");
dotenv.config({ path: path.join(projectDir, ".env.local"), override: true, quiet: true });
dotenv.config({ path: path.join(projectDir, ".env"), override: false, quiet: true });

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const redirectPort = 53682;
const redirectUri = `http://127.0.0.1:${redirectPort}/oauth2callback`;

if (!clientId || !clientSecret) {
  console.error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
});

function saveRefreshToken(refreshToken) {
  const envPath = path.join(projectDir, ".env");
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith("GMAIL_REFRESH_TOKEN=")) {
      replaced = true;
      return `GMAIL_REFRESH_TOKEN=${refreshToken}`;
    }
    return line;
  });
  if (!replaced) {
    next.push(`GMAIL_REFRESH_TOKEN=${refreshToken}`);
  }
  fs.writeFileSync(envPath, `${next.join("\n").replace(/\n+$/g, "")}\n`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", redirectUri);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("OAuth callback missing code");
    }

    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      throw new Error("Google did not return a refresh_token. Revoke the app and retry with consent.");
    }

    saveRefreshToken(refreshToken);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Gmail refresh token saved.</h1><p>You can close this tab.</p>");
    console.log("Gmail refresh token saved to .env");
    server.close(() => process.exit(0));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`OAuth failed: ${error.message}`);
    console.error(error);
    server.close(() => process.exit(1));
  }
});

server.listen(redirectPort, "127.0.0.1", () => {
  console.log(`Open this URL to authorize Gmail read-only access:\n${authUrl}`);
});
