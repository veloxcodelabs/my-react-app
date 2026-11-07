/**
 * POST /api/sait-za-20
 *
 * Generates one Bulgarian HTML preview per email, shows it to the visitor,
 * emails info@martitony.com, and POSTs the same submission to the webhook.
 *
 * Env:
 * - GEMINI_API_KEY: Google Gemini API key (required to generate)
 * - GEMINI_MODEL: optional model id, default gemini-3.5-flash-lite
 * - RESEND_API_KEY: owner email backup
 * - RESEND_FROM_EMAIL: optional verified sender
 * - SAIT20_WEBHOOK_URL / SAIT20_WEBHOOK_KEY: optional JSON webhook
 */

const OWNER_EMAIL = "info@martitony.com";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_PROMPT = 2000;
const MAX_BUSINESS = 120;
const MAX_IMAGES = 3;
const MAX_IMAGE_BASE64 = 1200000;
const MAX_IMAGES_BASE64 = 3200000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const USED_EMAILS = new Set();
const IN_FLIGHT = new Set();
const RATE_HITS = new Map();

const SITE_INSTRUCTIONS = `Write one compact Bulgarian business page as a single HTML document.
Output only the document, from <!DOCTYPE html> through </html>. No markdown and no commentary.
Stay under 160 lines. One short <style> block. No <script>, no external URLs, no webfonts, no comments.
Include a header, a hero with the business name, only the sections the visitor named, and a short footer.
Use CSS gradients where a photo is not provided. All visible text is Bulgarian. It must fit a phone screen.
Never write base64 or data: URLs. If the user lists {{PHOTO_N}} tokens, use those exact strings as img src values.`;

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

function geminiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function geminiModel() {
  const model = env("GEMINI_MODEL") || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(model)) {
    throw geminiError("config", "invalid model");
  }
  return model;
}

function textFromGemini(data) {
  return (data.candidates || [])
    .flatMap((candidate) => (candidate.content && candidate.content.parts) || [])
    .filter((part) => part && !part.thought)
    .map((part) => part.text || "")
    .join("");
}

function takeSseText(buffer, onText) {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const chunk = textFromGemini(json);
    if (chunk) onText(chunk);
  }
  return rest;
}

async function readGeminiStream(response, onDelta) {
  let text = "";
  let logged = false;
  const push = (chunk) => {
    if (!logged) {
      console.error("gemini first text");
      logged = true;
    }
    text += chunk;
    if (onDelta) onDelta(chunk);
  };

  if (!response.body || typeof response.body.getReader !== "function") {
    const data = await response.json().catch(() => ({}));
    const chunk = textFromGemini(data);
    if (chunk) push(chunk);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = takeSseText(buffer, push);
    if (/<\/body>/i.test(text) && /<\/html>/i.test(text)) {
      try {
        await reader.cancel();
      } catch {
        // The document is already complete.
      }
      break;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) takeSseText(`${buffer}\n`, push);
  return text;
}

function decodeImage(item, index) {
  if (!item || typeof item !== "object") {
    return { error: "Невалидна снимка." };
  }
  if (item.role !== "style" && item.role !== "embed") {
    return { error: "Избери дали снимката е пример за стил или да влезе в сайта." };
  }
  const mime = String(item.mime || "").toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") {
    return { error: "Само JPG, PNG или WebP." };
  }
  const source = String(item.data || "").trim();
  const dataUrl = source.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  const b64 = (dataUrl ? dataUrl[2] : source).replace(/\s/g, "");
  if (dataUrl && dataUrl[1].toLowerCase() !== mime) {
    return { error: "Само JPG, PNG или WebP." };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > MAX_IMAGE_BASE64) {
    return { error: "Снимката е твърде голяма след компресия. Качи по-малък файл." };
  }
  const buffer = Buffer.from(b64, "base64");
  const jpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const webp = buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  const matches = (mime === "image/jpeg" && jpeg) || (mime === "image/png" && png) || (mime === "image/webp" && webp);
  if (!matches) return { error: "Файлът не е валидна снимка." };
  return { image: { role: item.role, mime, data: b64, index } };
}

function collectImages(raw) {
  if (raw == null) return { images: [] };
  if (!Array.isArray(raw)) return { error: "Невалидни снимки." };
  if (raw.length > MAX_IMAGES) return { error: "Можеш да качиш до 3 снимки." };
  const images = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const decoded = decodeImage(raw[i], i);
    if (decoded.error) return decoded;
    total += decoded.image.data.length;
    if (total > MAX_IMAGES_BASE64) {
      return { error: "Снимките заедно са твърде големи. Махни една или качи по-малки." };
    }
    images.push(decoded.image);
  }
  return { images };
}

function insertEmbeds(html, images) {
  const embeds = images.filter((image) => image.role === "embed");
  let result = html;
  const missing = [];
  embeds.forEach((image, index) => {
    const token = `{{PHOTO_${index + 1}}}`;
    const url = `data:${image.mime};base64,${image.data}`;
    if (result.includes(token)) result = result.split(token).join(url);
    else missing.push(url);
  });
  if (missing.length) {
    const gallery = `<section>${missing
      .map((url) => `<img src="${url}" alt="" style="max-width:100%;height:auto;display:block">`)
      .join("")}</section>`;
    result = /<\/body>/i.test(result) ? result.replace(/<\/body>/i, `${gallery}</body>`) : `${result}${gallery}`;
  }
  return result;
}

function geminiUserParts({ business, prompt, images }) {
  const embeds = images.filter((image) => image.role === "embed");
  const styles = images.filter((image) => image.role === "style");
  const lines = [`Бизнес: ${business || "бизнес без посочено име"}`, `Страница: ${prompt}`];
  if (embeds.length) {
    lines.push("Вгради снимките само с тези src стойности, без base64:");
    embeds.forEach((_, index) => lines.push(`- {{PHOTO_${index + 1}}}`));
    lines.push("Първата е лого или hero. Останалите са галерия.");
  }
  if (styles.length) {
    lines.push("Следващите изображения са само пример за стил. Не ги вграждай и не повтаряй пикселите им.");
  }
  lines.push("Направи кратката страница сега.");
  const parts = [{ text: lines.join("\n") }];
  styles.forEach((image) => {
    parts.push({ inlineData: { mimeType: image.mime, data: image.data } });
  });
  return parts;
}

async function generateWithGemini({ business, prompt, images }, onDelta) {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    throw geminiError("config", "missing key");
  }

  const model = geminiModel();
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(`${GEMINI_URL}/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SITE_INSTRUCTIONS }] },
        contents: [
          {
            role: "user",
            parts: geminiUserParts({ business, prompt, images: images || [] }),
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (response.ok || response.status !== 503 || attempt === 1) break;
    console.error("gemini busy, retrying");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const statusName = data && data.error && data.error.status;
    const geminiMessage = String((data && data.error && data.error.message) || "").slice(0, 300);
    if (response.status === 429 || response.status === 402 || statusName === "RESOURCE_EXHAUSTED") {
      console.error("gemini quota", response.status, statusName || "", geminiMessage);
      throw geminiError("quota", "gemini quota");
    }
    console.error("gemini failed", response.status, statusName || "", geminiMessage);
    throw geminiError("generation", "gemini failed");
  }

  const text = await readGeminiStream(response, onDelta);
  if (!text.trim()) throw geminiError("generation", "empty model response");
  return text;
}

function startStream(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === "function") res.flush();
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
    `Снимки: ${(payload.images || []).map((image) => image.role).join(", ") || "няма"}`,
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
  const collected = collectImages(body.images);
  if (collected.error) {
    reply(res, 400, { ok: false, error: "validation", message: collected.error });
    return;
  }
  const images = collected.images;

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
  let streaming = false;
  const fail = (error) => {
    const code = error && error.code;
    console.error("preview generation failed", code || "unknown");
    const message =
      code === "quota"
        ? "Генераторът е временно зает заради лимит. Опитай отново след малко."
        : code === "config"
          ? "Генераторът не е настроен в момента. Пиши на info@martitony.com."
          : "Не успяхме да направим прегледа. Опитай отново след малко.";
    const errorName = code === "quota" ? "quota" : code === "config" ? "config" : "generation";
    if (!streaming) {
      reply(res, code === "quota" ? 429 : 503, { ok: false, error: errorName, message });
      return;
    }
    writeEvent(res, { type: "error", error: errorName, message });
    res.end();
  };

  try {
    const onDelta = (text) => {
      if (!streaming) {
        startStream(res);
        streaming = true;
      }
      writeEvent(res, { type: "delta", text });
    };
    const raw = handler._generate
      ? await handler._generate({ email, business, prompt, images })
      : await generateWithGemini({ business, prompt, images }, onDelta);
    if (handler._generate) onDelta(raw);
    const generatedHtml = insertEmbeds(sanitizePreviewHtml(raw), images);
    if (!/<\/body>/i.test(generatedHtml) || !/<\/html>/i.test(generatedHtml)) {
      throw geminiError("generation", "incomplete html");
    }
    const payload = {
      email,
      business,
      prompt,
      submittedAt: new Date().toISOString(),
      generatedHtml,
      images: images.map((image) => ({
        role: image.role,
        mime: image.mime,
        data: image.data,
      })),
    };

    await Promise.all([postWebhook(payload), sendOwnerEmail(payload)]);
    await rememberEmail(email);
    if (!streaming) startStream(res);
    writeEvent(res, { type: "done", html: generatedHtml });
    res.end();
  } catch (error) {
    fail(error);
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
