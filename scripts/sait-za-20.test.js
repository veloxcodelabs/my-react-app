const assert = require("node:assert/strict");
const test = require("node:test");
const handler = require("../api/sait-za-20");

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

function submit(body, method = "POST") {
  const res = mockRes();
  return handler({ method, body }, res).then(() => res);
}

test.beforeEach(() => {
  handler._reset();
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.SAIT20_WEBHOOK_URL;
  delete process.env.SAIT20_WEBHOOK_KEY;
});

test("rejects an empty description", async () => {
  const res = await submit({ email: "a@b.co", prompt: "кратко", business: "" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.ok, false);
});

test("posts the webhook and emails the owner", async () => {
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
    prompt: "Семейна пекарна, топъл стил, секции начало, меню и контакти.",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(calls.length, 2);

  const webhook = calls.find((call) => call.url === "https://hooks.example.com/sait");
  const email = calls.find((call) => call.url === "https://api.resend.com/emails");
  assert.ok(webhook);
  assert.ok(email);

  assert.equal(webhook.options.headers.Authorization, "Bearer secret-key");
  assert.equal(webhook.options.headers["X-Webhook-Key"], "secret-key");
  const payload = JSON.parse(webhook.options.body);
  assert.equal(payload.email, "client@example.com");
  assert.equal(payload.business, "Пекарна");
  assert.equal(payload.source, "sait-za-20");
  assert.equal(typeof payload.submittedAt, "string");
  assert.match(payload.prompt, /пекарна/);

  const message = JSON.parse(email.options.body);
  assert.deepEqual(message.to, ["info@martitony.com"]);
  assert.equal(message.reply_to, "client@example.com");
  assert.equal(message.from, "Marti Tony <preview@martitony.com>");
  assert.match(message.text, /client@example.com/);
  assert.equal(email.options.headers.Authorization, "Bearer re_test");
});

test("skips the webhook when the env vars are unset and still emails", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({
    email: "one@example.com",
    prompt: "Студио за керамика, светъл стил, начало, галерия и контакти.",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const message = JSON.parse(calls[0].options.body);
  assert.equal(JSON.parse(calls[0].options.body).to[0], "info@martitony.com");
  assert.match(message.text, /—/);
});

test("accepts the lead when only the webhook is configured", async () => {
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({
    email: "hook@example.com",
    business: "",
    prompt: "Фризьорски салон, смел стил, начало, услуги и записване.",
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ["https://hooks.example.com/sait"]);
});

test("returns a graceful error when delivery is not configured", async () => {
  global.fetch = async () => {
    throw new Error("fetch should not be called");
  };
  const res = await submit({
    email: "none@example.com",
    prompt: "Книжарница, класически стил, начало, каталог и контакти.",
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /info@martitony.com/);
});

test("allows one free preview per email", async () => {
  process.env.RESEND_API_KEY = "re_test";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => "" };
  };
  const body = {
    email: "twice@example.com",
    prompt: "Кафене, уютен стил, начало, меню и контакти.",
  };

  const first = await submit(body);
  const second = await submit(body);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.payload.error, "duplicate");
  assert.equal(calls, 1);
});

test("still emails the owner when the webhook fails", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.SAIT20_WEBHOOK_URL = "https://hooks.example.com/sait";
  process.env.SAIT20_WEBHOOK_KEY = "secret-key";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.includes("hooks.example.com")) {
      return { ok: false, status: 500, text: async () => "nope" };
    }
    return { ok: true, status: 200, text: async () => "" };
  };

  const res = await submit({
    email: "backup@example.com",
    prompt: "Хотел, спокоен стил, начало, стаи и резервация.",
  });

  assert.equal(res.statusCode, 200);
  assert.ok(calls.includes("https://api.resend.com/emails"));
});
