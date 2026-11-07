import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("apex and www /sait-za-20 redirect permanently to the generator host", () => {
  const rules = config.redirects.filter((rule) => rule.destination === "https://site.martitony.com");
  const hosts = rules.flatMap((rule) => rule.has.filter((item) => item.type === "host").map((item) => item.value));
  assert.deepEqual(hosts.sort(), ["martitony.com", "martitony.com", "www.martitony.com", "www.martitony.com"].sort());
  for (const rule of rules) {
    assert.equal(rule.permanent, true);
    assert.match(rule.source, /^\/sait-za-20\/?$/);
  }
});

test("the SPA rewrite does not replace the API route by name", () => {
  assert.ok(config.functions["api/sait-za-20.mjs"]);
  assert.ok(config.rewrites.some((rule) => rule.destination === "/index.html"));
});
