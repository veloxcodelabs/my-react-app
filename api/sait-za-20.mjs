/**
 * POST /api/sait-za-20
 *
 * Generates one Bulgarian HTML preview per email, shows it to the visitor,
 * emails info@martitony.com, and POSTs the same submission to the webhook.
 *
 * Env:
 * - VERCEL_OIDC_TOKEN: set automatically on Vercel; authenticates AI Gateway
 * - AI_GATEWAY_API_KEY: only for local/non-Vercel runs (used instead of OIDC)
 * - AI_GATEWAY_MODEL: optional provider/model id; default google/gemini-3.8-flash
 * - RESEND_API_KEY: owner email backup
 * - RESEND_FROM_EMAIL: optional verified sender
 * - SAIT20_WEBHOOK_URL / SAIT20_WEBHOOK_KEY: optional JSON webhook
 */

import { generateText } from "ai";

const OWNER_EMAIL = "info@martitony.com";
const DEFAULT_MODEL = "google/gemini-3.8-flash";
const MAX_PROMPT = 2000;
const MAX_BUSINESS = 120;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const USED_EMAILS = new Set();
const IN_FLIGHT = new Set();
const RATE_HITS = new Map();

const SITE_INSTRUCTIONS = `You write one complete, beautiful, responsive HTML5 document for a small-business website.
Rules:
- All visible text is Bulgarian.
- One file only. Put all CSS in a single <style> block in the head. No external stylesheets, fonts, images, or scripts.
- No <script>, no iframes, no javascript: URLs, no event-handler attributes.
- Modern, distinctive layout that fits the business. Use the business name as the title and hero.
- Build the sections the visitor described. If they did not name sections, include a hero, about, offer, and contact.
- Pictures are CSS gradients, shapes, or inline SVG only. Do not use http(s) image URLs.
- The page must look finished on a phone and on a desktop.
- Output only the document, starting with <!DOCTYPE html>. No markdown.`;

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

function header(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || "";
}

function clientIp(req) {
  const forwarded = header(req, "x-forwarded-for");
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || header(req, "x-real-ip");
  return String(raw).split(",")[0].trim() || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (RATE_HITS.get(ip) || []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    RATE_HITS.set(ip, recent);
    return true;
  }
  recent.push(now);
  RATE_HITS.set(ip, recent);
  return false;
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
  } catch {
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
  } catch {
    console.error("preview dedupe write failed");
  }
}

function stripActiveContent(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<iframe\b[^>]*\/?>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/url\(\s*(['"]?)https?:\/\/[^)'"]+\1\s*\)/gi, "none")
    .replace(/\s(?:src|srcset)\s*=\s*(['"])https?:\/\/[^'"]*\1/gi, "");
}

function injectWatermark(html) {
  const mark = [
    '<div id="sait-preview-mark" style="position:fixed !important;inset:0 !important;z-index:2147483647 !important;pointer-events:none !important;display:flex !important;align-items:center !important;justify-content:center !important;">',
    '<div style="font:800 64px/1 sans-serif !important;letter-spacing:.18em !important;color:rgba(0,112,243,.28) !important;transform:rotate(-18deg) !important;">ПРЕГЛЕД</div>',
    "</div>",
  ].join("");
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${mark}</body>`);
  return `${html}${mark}`;
}

export function sanitizePreviewHtml(raw) {
  let html = String(raw || "").trim().replace(/^\uFEFF/, "");
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Преглед</title></head><body>${html}</body></html>`;
  }
  const end = html.toLowerCase().lastIndexOf("</html>");
  if (end >= 0) html = html.slice(0, end + "</html>".length);
  html = stripActiveContent(html);
  html = injectWatermark(html);
  if (html.length < 40 || html.length > 150000 || !html.includes("ПРЕГЛЕД")) {
    throw new Error("preview html rejected");
  }
  return html;
}

async function generateWithGateway({ business, prompt }) {
  const model = env("AI_GATEWAY_MODEL") || DEFAULT_MODEL;
  const businessLine = business || "бизнес без посочено име";
  const result = await generateText({
    model,
    instructions: SITE_INSTRUCTIONS,
    prompt: `Име на бизнеса: ${businessLine}\n\nОписание от клиента:\n${prompt}`,
    maxOutputTokens: 8000,
    temperature: 0.7,
    reasoning: "low",
    maxRetries: 0,
    timeout: 50000,
  });
  if (!result.text || !result.text.trim()) {
    throw new Error("empty model response");
  }
  return result.text;
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
    return { skipped: true, ok: false };
  }

  const from = env("RESEND_FROM_EMAIL") || "Marti Tony Studio <onboarding@resend.dev>";
  const businessLine = payload.business || "—";
  const subject = `Сайт за €20 — ${payload.business || payload.email}`
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
  const text = [
    "Нов безплатен преглед (Сайт за €20).",
    "",
    `Имейл: ${payload.email}`,
    `Бизнес: ${businessLine}`,
    `Изпратено: ${payload.submittedAt}`,
    "",
    "Описание:",
    payload.prompt,
    "",
    "Генериран HTML:",
    payload.generatedHtml,
  ].join("\n");
  const html = [
    "<h2>Нов безплатен преглед</h2>",
    `<p><strong>Имейл:</strong> ${escapeHtml(payload.email)}</p>`,
    `<p><strong>Бизнес:</strong> ${escapeHtml(businessLine)}</p>`,
    `<p><strong>Изпратено:</strong> ${escapeHtml(payload.submittedAt)}</p>`,
    "<p><strong>Описание:</strong></p>",
    `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(payload.prompt)}</pre>`,
    "<p>Пълният HTML е в текстовата версия на писмото.</p>",
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
    if (!response.ok) {
      const details = await response.text();
      console.error("resend failed", response.status, details.slice(0, 400));
      return { skipped: false, ok: false };
    }
    return { skipped: false, ok: true };
  } catch (error) {
    console.error("resend error", error && error.message ? error.message : "unknown");
    return { skipped: false, ok: false };
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
  if (business.length > MAX_BUSINESS) {
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
  if (prompt.length > MAX_PROMPT) {
    reply(res, 400, {
      ok: false,
      error: "validation",
      message: `Описанието е твърде дълго. Съкрати го до ${MAX_PROMPT} знака.`,
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
  if (IN_FLIGHT.has(email)) {
    reply(res, 429, {
      ok: false,
      error: "busy",
      message: "Вече правим преглед за този имейл.",
    });
    return;
  }
  if (rateLimited(clientIp(req))) {
    reply(res, 429, {
      ok: false,
      error: "rate",
      message: "Твърде много заявки от тази мрежа. Опитай отново след малко.",
    });
    return;
  }

  IN_FLIGHT.add(email);
  try {
    const raw = handler._generate
      ? await handler._generate({ email, business, prompt })
      : await generateWithGateway({ business, prompt });
    const generatedHtml = sanitizePreviewHtml(raw);
    const payload = {
      email,
      business,
      prompt,
      submittedAt: new Date().toISOString(),
      generatedHtml,
    };

    await Promise.all([postWebhook(payload), sendOwnerEmail(payload)]);
    await rememberEmail(email);
    reply(res, 200, { ok: true, html: generatedHtml });
  } catch (error) {
    console.error("preview generation failed", error && error.message ? error.message : "unknown");
    reply(res, 503, {
      ok: false,
      error: "generation",
      message: "Не успяхме да направим прегледа. Опитай отново след малко.",
    });
  } finally {
    IN_FLIGHT.delete(email);
  }
}

handler._reset = () => {
  USED_EMAILS.clear();
  IN_FLIGHT.clear();
  RATE_HITS.clear();
};

export const config = { maxDuration: 60 };
export default handler;
