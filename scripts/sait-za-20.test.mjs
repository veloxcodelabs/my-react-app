import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/sait-za-20.mjs";

const FIXTURE =
  "<!DOCTYPE html><html><head><title>Тест</title></head><body><h1>Здравей</h1><script>alert(1)</script><img src=\"https://evil.example/a.png\"></body></html>";
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function mockRes() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
    chunks: "",
    write(chunk) {
      this.chunks += chunk;
    },
    end() {
      this.ended = true;
    },
    flushHeaders() {},
  };
}

function doneHtml(res) {
  const events = String(res.chunks || "")
    .split("\n\n")
    .map((block) => {
      const line = block.split("\n").find((item) => item.startsWith("data:"));
      return line ? JSON.parse(line.slice(5).trim()) : null;
    })
    .filter(Boolean);
  const done = events.filter((event) => event.type === "done").pop();
  if (!done) throw new Error(`missing done event: ${res.chunks}`);
  return done.html;
}

function submit(body, method = "POST", headers = {}) {
  const res = mockRes();
  return handler({ method, body, headers }, res).then(() => res);
}

const prompt = "Семейна пекарна в Пловдив, топъл стил, секции начало, меню и контакти.";

let tail = Promise.resolve();
function solo(name, fn) {
  let begin = () => {};
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const done = tail.then(() => started).then(async () => {
    handler._reset();
    handler._generate = async () => FIXTURE;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.SAIT20_WEBHOOK_URL;
    delete process.env.SAIT20_WEBHOOK_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
    await fn();
  });
  tail = done.then(
    () => {},
    () => {}
  );
  test(name, async () => {
    begin();
    await done;
  });
}

solo("rejects a short description and an oversized prompt", async () => {
  const short = await submit({ email: "a@b.co", prompt: "кратко", business: "" });
  assert.equal(short.statusCode, 400);

  const long = await submit({ email: "a@b.co", prompt: "а".repeat(2001), business: "" });
  assert.equal(long.statusCode, 400);
  assert.match(long.payload.message, /2000/);
});

solo("returns sanitized html and notifies the owner", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "Marti Tony <preview@martitony.com>";
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({
    email: " Client@Example.com ",
    business: "Пекарна",
    prompt,
  });

  assert.equal(res.statusCode, 200);
  const html = doneHtml(res);
  assert.match(html, /Здравей/);
  assert.match(html, /ПРЕГЛЕД/);
  assert.match(html, /<\/html>/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /evil\.example/);

  const webhook = calls.find((call) => call.url === "https://hooks.example.com/sait");
  const email = calls.find((call) => call.url === "https://api.resend.com/emails");
  assert.ok(webhook);
  assert.ok(email);
  assert.equal(webhook.options.headers.Authorization, "Bearer secret-key");
  assert.equal(webhook.options.headers["X-Webhook-Key"], "secret-key");

  const payload = JSON.parse(webhook.options.body);
  assert.deepEqual(Object.keys(payload).sort(), [
    "business",
    "email",
    "generatedHtml",
    "photoCount",
    "photos",
    "prompt",
    "submittedAt",
  ]);
  assert.equal(payload.photoCount, 0);
  assert.deepEqual(payload.photos, []);
  console.log("WEBHOOK_BYTES_NO_PHOTOS", Buffer.byteLength(webhook.options.body));
  assert.equal(payload.email, "client@example.com");
  assert.equal(payload.business, "Пекарна");
  assert.equal(payload.prompt, prompt);
  assert.match(payload.generatedHtml, /ПРЕГЛЕД/);
  assert.match(payload.generatedHtml, /<\/html>/i);
  assert.equal(payload.generatedHtml, html);
  assert.doesNotMatch(payload.generatedHtml, /<script/i);

  const message = JSON.parse(email.options.body);
  assert.deepEqual(message.to, ["info@martitony.com"]);
  assert.equal(message.reply_to, "client@example.com");
  assert.match(message.text, /client@example.com/);
  assert.match(message.text, /ПРЕГЛЕД/);
});

solo("skips the webhook when unset and still emails", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({ email: "one@example.com", prompt });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
});

solo("still shows the preview when notification is not configured", async () => {
  global.fetch = async () => {
    throw new Error("fetch should not be called");
  };
  const res = await submit({ email: "none@example.com", prompt });
  assert.equal(res.statusCode, 200);
  assert.match(doneHtml(res), /Здравей/);
});

solo("allows one free generation per email", async () => {
  let calls = 0;
  handler._generate = async () => {
    calls += 1;
    return FIXTURE;
  };
  const body = { email: "twice@example.com", prompt };
  const first = await submit(body);
  const second = await submit(body);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.error, "duplicate");
  assert.equal(calls, 1);
});

solo("a paid credit allows one extra generation and only once", async () => {
  let calls = 0;
  handler._generate = async () => {
    calls += 1;
    return FIXTURE;
  };
  const body = { email: "paid@example.com", prompt };
  const first = await submit(body);
  const blocked = await submit(body);
  const extra = await submit({ ...body, usePaidCredit: true });
  const again = await submit({ ...body, usePaidCredit: true });
  assert.equal(first.statusCode, 200);
  assert.equal(blocked.statusCode, 409);
  assert.equal(extra.statusCode, 200);
  assert.equal(again.statusCode, 409);
  assert.equal(again.payload.error, "duplicate");
  assert.equal(calls, 2);
});

solo("a paid flag on the free generation does not use up the extra", async () => {
  const body = { email: "flag@example.com", prompt, usePaidCredit: true };
  assert.equal((await submit(body)).statusCode, 200);
  assert.equal((await submit(body)).statusCode, 200);
  assert.equal((await submit(body)).statusCode, 409);
});

solo("does not spend the paid credit when that generation fails", async () => {
  const body = { email: "paid-retry@example.com", prompt };
  assert.equal((await submit(body)).statusCode, 200);
  handler._generate = async () => {
    throw new Error("gateway down");
  };
  const failed = await submit({ ...body, usePaidCredit: true });
  assert.equal(failed.statusCode, 503);
  handler._generate = async () => FIXTURE;
  const extra = await submit({ ...body, usePaidCredit: true });
  assert.equal(extra.statusCode, 200);
  const again = await submit({ ...body, usePaidCredit: true });
  assert.equal(again.statusCode, 409);
});

solo("does not spend the free generation when the model fails", async () => {
  handler._generate = async () => {
    throw new Error("gateway down");
  };
  const body = { email: "retry@example.com", prompt };
  const failed = await submit(body);
  assert.equal(failed.statusCode, 503);

  handler._generate = async () => FIXTURE;
  const again = await submit(body);
  assert.equal(again.statusCode, 200);
});

solo("rate limits an address after five generations", async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "" });
  for (let i = 1; i <= 5; i += 1) {
    const res = await submit(
      { email: `rate${i}@example.com`, prompt },
      "POST",
      { "x-forwarded-for": "203.0.113.10" }
    );
    assert.equal(res.statusCode, 200);
  }
  const blocked = await submit(
    { email: "rate6@example.com", prompt },
    "POST",
    { "x-forwarded-for": "203.0.113.10" }
  );
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.error, "rate");
});

solo("explains a Gemini quota limit and still allows a retry", async () => {
  delete handler._generate;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.8-flash";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
    };
  };

  const limited = await submit({ email: "quota@example.com", prompt });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.payload.error, "quota");
  assert.match(limited.payload.message, /лимит/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(calls[0].url.includes("test-gemini-key"), false);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "test-gemini-key");

  handler._generate = async () => FIXTURE;
  const again = await submit({ email: "quota@example.com", prompt });
  assert.equal(again.statusCode, 200);
});

solo("says the generator is not configured when the key is missing", async () => {
  delete handler._generate;
  global.fetch = async () => {
    throw new Error("gemini should not be called");
  };
  const res = await submit({ email: "nokey@example.com", prompt });
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, "config");
  assert.match(res.payload.message, /info@martitony.com/);
});

solo("rejects more than three photos and a fake image", async () => {
  const tooMany = await submit({
    email: "photos@example.com",
    prompt,
    images: [1, 2, 3, 4].map(() => ({ role: "style", mime: "image/png", data: TINY_PNG })),
  });
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.payload.message, /3/);

  const fake = await submit({
    email: "photos@example.com",
    prompt,
    images: [{ role: "embed", mime: "image/png", data: "aaaa" }],
  });
  assert.equal(fake.statusCode, 400);
});

solo("embeds a photo through a placeholder and sends only the style photo to Gemini", async () => {
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete handler._generate;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const sse = `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '<!DOCTYPE html><html><body><img src="{{PHOTO_1}}" alt="hero"></body></html>',
                },
              ],
            },
          },
        ],
      })}\n\n`;
      const encoded = new TextEncoder().encode(sse);
      let sent = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: encoded };
              },
              async cancel() {},
            };
          },
        },
      };
    }
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({
    email: "photos2@example.com",
    prompt,
    images: [
      { role: "style", mime: "image/png", data: TINY_PNG },
      { role: "embed", mime: "image/png", data: TINY_PNG },
    ],
  });
  const html = doneHtml(res);
  assert.match(html, /data:image\/png;base64,/);
  assert.equal(html.includes("{{PHOTO_1}}"), false);
  const geminiCall = calls.find((call) => call.url.includes("generativelanguage.googleapis.com"));
  const gemini = JSON.parse(geminiCall.options.body);
  const parts = gemini.contents[0].parts;
  assert.equal(parts.filter((part) => part.inlineData).length, 1);
  assert.equal(parts[1].inlineData.data, TINY_PNG);
  assert.equal(parts[0].text.includes(TINY_PNG), false);
  const webhook = calls.find((call) => call.url.includes("hooks.example.com"));
  const payload = JSON.parse(webhook.options.body);
  assert.equal(payload.generatedHtml.includes(TINY_PNG), false);
  assert.equal(payload.generatedHtml.includes("data:image"), false);
  assert.match(payload.generatedHtml, /\{\{PHOTO_1\}\}/);
  assert.equal(payload.photoCount, 2);
  assert.deepEqual(
    payload.photos.map((image) => image.role),
    ["style", "embed"]
  );
  console.log("WEBHOOK_BYTES_TINY_PHOTOS", Buffer.byteLength(webhook.options.body));
});

solo("omits photos from the webhook when they exceed 200 KB", async () => {
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => "" };
  };
  const bulky = Buffer.concat([
    Buffer.from(TINY_PNG, "base64"),
    Buffer.alloc(220 * 1024, 7),
  ]).toString("base64");
  handler._generate = async () =>
    '<!DOCTYPE html><html><body><img src="{{PHOTO_1}}" alt="hero"><p>Пекарна</p></body></html>';
  const res = await submit({
    email: "bulky@example.com",
    prompt,
    images: [{ role: "embed", mime: "image/png", data: bulky }],
  });
  assert.match(doneHtml(res), /data:image\/png;base64,/);
  const webhook = calls.find((call) => call.url.includes("hooks.example.com"));
  const payload = JSON.parse(webhook.options.body);
  assert.equal(payload.photos, undefined);
  assert.equal(payload.photoCount, 1);
  assert.equal(payload.generatedHtml.includes(bulky), false);
  assert.match(payload.generatedHtml, /\{\{PHOTO_1\}\}/);
  console.log("WEBHOOK_BYTES_OMITTED_PHOTOS", Buffer.byteLength(webhook.options.body));
});

solo("measures a typical compact-page webhook", async () => {
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => "" };
  };
  const page = `<!DOCTYPE html><html lang="bg"><head><title>Пекарна</title><style>body{margin:0;font-family:sans-serif}</style></head><body><h1>Пекарна Зърно</h1>${"<p>Топъл хляб и баница за семейството в Пловдив.</p>".repeat(80)}</body></html>`;
  handler._generate = async () => page;
  await submit({ email: "typical@example.com", business: "Пекарна Зърно", prompt });
  const webhook = calls.find((call) => call.url.includes("hooks.example.com"));
  const bytes = Buffer.byteLength(webhook.options.body);
  const payload = JSON.parse(webhook.options.body);
  assert.equal(payload.photoCount, 0);
  assert.ok(bytes < 20000, `typical payload was ${bytes}`);
  console.log("WEBHOOK_BYTES_TYPICAL_PAGE", bytes, "html", payload.generatedHtml.length);
});
