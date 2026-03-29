export async function deliverToOpenClaw(config, logger, mail) {
  if (!config.openclaw.deliveryEnabled) {
    logger.info("OpenClaw delivery disabled, skipping", mail.id);
    return { skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.openclaw.timeoutMs);

  try {
    const response = await fetch(config.openclaw.hookUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${config.openclaw.hookToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "openclaw-mail-bridge",
        messages: [mail],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenClaw hook failed: ${response.status} ${text}`);
    }

    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}
