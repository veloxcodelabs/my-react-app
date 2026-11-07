import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/sait-za-20.mjs";

const FIXTURE =
  "<!DOCTYPE html><html><head><title>Тест</title></head><body><h1>Здравей</h1><script>alert(1)</script><img src=\"https://evil.example/a.png\"></body></html>";

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
  };
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
  assert.equal(res.payload.ok, true);
  assert.match(res.payload.html, /Здравей/);
  assert.match(res.payload.html, /ПРЕГЛЕД/);
  assert.doesNotMatch(res.payload.html, /<script/i);
  assert.doesNotMatch(res.payload.html, /evil\.example/);

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
    "prompt",
    "submittedAt",
  ]);
  assert.equal(payload.email, "client@example.com");
  assert.equal(payload.business, "Пекарна");
  assert.equal(payload.prompt, prompt);
  assert.match(payload.generatedHtml, /ПРЕГЛЕД/);
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
  assert.match(res.payload.html, /Здравей/);
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
