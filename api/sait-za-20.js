/**
 * POST /api/sait-za-20
 *
 * Sends each preview request to info@martitony.com via Resend and, when
 * configured, POSTs the same submission to SAIT20_WEBHOOK_URL.
 *
 * Env:
 * - RESEND_API_KEY (required for the email backup)
 * - RESEND_FROM_EMAIL (optional verified sender; sandbox default otherwise)
 * - SAIT20_WEBHOOK_URL (optional; skipped when unset)
 * - SAIT20_WEBHOOK_KEY (optional; skipped when unset)
 */

const OWNER_EMAIL = "info@martitony.com";
const USED_EMAILS = new Set();

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  if (/[\s<>]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function asText(value) {
  return String(value == null ? "" : value).replace(/\u0000/g, "").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readJson(req) {
  const body = req.body;
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === "object") return body;
  return {};
}

function reply(res, status, payload) {
  res.status(status);
  res.json(payload);
}

function usedRequest(email) {
  return new Request(`https://sait-za-20.internal/used/${encodeURIComponent(email)}`);
}

async function hasUsedEmail(email) {
  if (USED_EMAILS.has(email)) return true;
  if (typeof caches === "undefined" || typeof caches.open !== "function") return false;
  try {
    const cache = await caches.open("sait-za-20");
    const hit = await cache.match(usedRequest(email));
    if (hit) {
      USED_EMAILS.add(email);
      return true;
    }
  } catch (error) {
    console.error("preview dedupe read failed");
  }
  return false;
}

async function rememberEmail(email) {
  USED_EMAILS.add(email);
  if (typeof caches === "undefined" || typeof caches.open !== "function") return;
  try {
    const cache = await caches.open("sait-za-20");
    await cache.put(
      usedRequest(email),
      new Response("1", {
        headers: { "Cache-Control": "public, max-age=31536000" },
      })
    );
  } catch (error) {
    console.error("preview dedupe write failed");
  }
}

async function postWebhook(payload) {
  const url = env("SAIT20_WEBHOOK_URL");
  const key = env("SAIT20_WEBHOOK_KEY");
  if (!url || !key) return { skipped: true, ok: false };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error("SAIT20_WEBHOOK_URL is not a valid URL");
    return { skipped: false, ok: false };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.error("SAIT20_WEBHOOK_URL must use http or https");
    return { skipped: false, ok: false };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Webhook-Key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 300 && response.status < 400) {
      console.error("webhook refused redirect", response.status);
      return { skipped: false, ok: false };
    }
    if (!response.ok) {
      console.error("webhook failed", response.status);
      return { skipped: false, ok: false };
    }
    return { skipped: false, ok: true };
  } catch (error) {
    console.error("webhook error", error && error.message ? error.message : "unknown");
    return { skipped: false, ok: false };
  }
}

async function sendOwnerEmail(payload) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY is not set; owner email skipped");
    return { skipped: true, ok: false, duplicate: false };
  }

  const from = env("RESEND_FROM_EMAIL") || "Marti Tony Studio <onboarding@resend.dev>";
  const businessLine = payload.business || "—";
  const subject = `Сайт за €20 — ${payload.business || payload.email}`
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
  const text = [
    "Нова заявка за безплатен преглед (Сайт за €20).",
    "",
    `Имейл: ${payload.email}`,
    `Бизнес: ${businessLine}`,
    `Изпратено: ${payload.submittedAt}`,
    "",
    "Описание:",
    payload.prompt,
  ].join("\n");
  const html = [
    "<h2>Нова заявка за безплатен преглед</h2>",
    `<p><strong>Имейл:</strong> ${escapeHtml(payload.email)}</p>`,
    `<p><strong>Бизнес:</strong> ${escapeHtml(businessLine)}</p>`,
    `<p><strong>Изпратено:</strong> ${escapeHtml(payload.submittedAt)}</p>`,
    "<p><strong>Описание:</strong></p>",
    `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(payload.prompt)}</pre>`,
  ].join("");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `sait-za-20/${payload.email}`.slice(0, 256),
      },
      body: JSON.stringify({
        from,
        to: [OWNER_EMAIL],
        reply_to: payload.email,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.status === 409) {
      return { skipped: false, ok: false, duplicate: true };
    }
    if (!response.ok) {
      const details = await response.text();
      console.error("resend failed", response.status, details.slice(0, 400));
      return { skipped: false, ok: false, duplicate: false };
    }
    return { skipped: false, ok: true, duplicate: false };
  } catch (error) {
    console.error("resend error", error && error.message ? error.message : "unknown");
    return { skipped: false, ok: false, duplicate: false };
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    reply(res, 405, { ok: false, error: "method", message: "Методът не е позволен." });
    return;
  }

  const body = readJson(req);
  if (!body || typeof body !== "object") {
    reply(res, 400, { ok: false, error: "validation", message: "Невалидни данни." });
    return;
  }

  const email = normalizeEmail(body.email);
  const business = asText(body.business);
  const prompt = asText(body.prompt);

  if (!isValidEmail(email)) {
    reply(res, 400, { ok: false, error: "validation", message: "Въведи валиден имейл." });
    return;
  }
  if (business.length > 120) {
    reply(res, 400, {
      ok: false,
      error: "validation",
      message: "Името на бизнеса е твърде дълго.",
    });
    return;
  }
  if (prompt.length < 20) {
    reply(res, 400, {
      ok: false,
      error: "validation",
      message: "Опиши сайта малко по-подробно — бизнес, стил и секции.",
    });
    return;
  }
  if (prompt.length > 5000) {
    reply(res, 400, {
      ok: false,
      error: "validation",
      message: "Описанието е твърде дълго. Съкрати го до 5000 знака.",
    });
    return;
  }

  if (await hasUsedEmail(email)) {
    reply(res, 409, {
      ok: false,
      error: "duplicate",
      message: "Този имейл вече е използван за безплатния преглед.",
    });
    return;
  }

  const payload = {
    email,
    business,
    prompt,
    submittedAt: new Date().toISOString(),
    source: "sait-za-20",
  };

  const [webhook, emailResult] = await Promise.all([
    postWebhook(payload),
    sendOwnerEmail(payload),
  ]);

  if (emailResult.duplicate) {
    await rememberEmail(email);
    reply(res, 409, {
      ok: false,
      error: "duplicate",
      message: "Този имейл вече е използван за безплатния преглед.",
    });
    return;
  }

  if (!webhook.ok && !emailResult.ok) {
    reply(res, 503, {
      ok: false,
      error: "delivery",
      message:
        "Не успяхме да приемем заявката. Опитай отново след малко или пиши на info@martitony.com.",
    });
    return;
  }

  await rememberEmail(email);
  reply(res, 200, { ok: true });
}

handler._reset = () => {
  USED_EMAILS.clear();
};

module.exports = handler;
