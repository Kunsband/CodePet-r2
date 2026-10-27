const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeAgyGeminiQuota,
  normalizeClaudeUsage,
  normalizeGrokUsage,
  readGrokUsage,
  tierLabel,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

const partnerQuota = { groups: [{ displayName: "Claude and GPT models",
  buckets: [{ displayName: "Weekly Limit Remaining", remainingFraction: 1, resetTime: "2026-11-03T01:00:00Z" }] }] };
const geminiModels = { models: {
  "gemini-flash": { displayName: "Gemini Flash", quotaInfo: { remainingFraction: 0.7, resetTime: "2026-11-03T02:00:00Z" } },
} };

function mockAgyQuota(t, { summary = partnerQuota, models = geminiModels, modelStatus = 200 } = {}) {
  clearUsageCache();
  t.after(() => clearUsageCache());
  const requests = [];
  t.mock.method(global, "fetch", async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith(":loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: { id: "projects/test" } });
    if (url.includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    if (url.endsWith(":retrieveUserQuotaSummary")) return jsonResponse(summary);
    if (url.endsWith(":fetchAvailableModels")) return jsonResponse(models, modelStatus);
    throw new Error("Unexpected endpoint");
  });
  return requests;
}

test("Gemini tier catalog excludes legacy/internal models and collapses matching quota rows", () => {
  const quotaInfo = { remainingFraction: 1, resetTime: "reset" };
  const models = { models: {
    "gemini-lite": { displayName: "Gemini Lite", quotaInfo },
    "gemini-tiered": { quotaInfo },
    "gemini-legacy": { displayName: "Gemini Legacy", quotaInfo: { remainingFraction: 0 } },
    "gemini-hidden": { displayName: "Gemini Internal", isInternal: true, quotaInfo: { remainingFraction: 0 } },
    "tab_internal": { quotaInfo },
    "claude-sonnet": { displayName: "Claude Sonnet", quotaInfo },
  }, tieredModelIds: { flashLite: ["gemini-lite"], flash: ["gemini-tiered"], pro: ["gemini-tiered", "gemini-hidden"] } };
  assert.deepEqual(normalizeAgyGeminiQuota(models), [{ label: "Gemini", usedPercent: 0, resetText: "reset" }]);
});

test("Gemini fallback preserves different model limits, deduplicates aliases and keeps explicit zero", () => {
  const flash = { displayName: "Gemini Flash", quotaInfo: { remainingFraction: "0.7", resetTime: "first" } };
  assert.deepEqual(normalizeAgyGeminiQuota({ models: {
    "gemini-flash": flash, "gemini-alias": flash,
    "gemini-pro": { displayName: "Gemini Pro", quota_info: { remaining_fraction: 0, reset_time: "second" } },
  } }), [
    { label: "Gemini Flash", usedPercent: 30, resetText: "first" },
    { label: "Gemini Pro", usedPercent: 100, resetText: "second" },
  ]);
});

test("missing or malformed Gemini quota never becomes a full balance or falls back to stale aliases", () => {
  for (const value of [undefined, null, "", " ", false, {}, "unknown", NaN, Infinity]) {
    assert.deepEqual(normalizeAgyGeminiQuota({ models: {
      "gemini-flash": { displayName: "Gemini Flash", quotaInfo: { remainingFraction: value } },
    } }), []);
  }
  assert.deepEqual(normalizeAgyGeminiQuota({ tieredModelIds: { flash: ["gemini-current"] }, models: {
    "gemini-current": { displayName: "Gemini", quotaInfo: {} },
    "gemini-old": { displayName: "Gemini Old", quotaInfo: { remainingFraction: 1 } },
  } }), []);
  assert.deepEqual(normalizeAgyGeminiQuota(null), []);
});

test("AGY supplements a partner-only summary with Gemini using the same project and credential", async (t) => {
  const requests = mockAgyQuota(t);
  const result = await fetchAntigravityUsage({ credential: { token: { access_token: "test-access" } }, force: true });
  assert.deepEqual(result.gauges, [
    ...normalizeAgyQuota(partnerQuota), { label: "Gemini", usedPercent: 30, resetText: "2026-11-03T02:00:00Z" },
  ]);
  const modelRequest = requests.find(({ url }) => url.endsWith(":fetchAvailableModels"));
  assert.deepEqual(JSON.parse(modelRequest.options.body), { project: "projects/test" });
  assert.equal(modelRequest.options.headers.authorization, "Bearer test-access");
});

test("AGY keeps authoritative Gemini summary windows without an extra model request", async (t) => {
  const summary = { groups: [{ displayName: "Gemini models", buckets: [
    { displayName: "5-hour Remaining", remainingFraction: 0.5 },
    { displayName: "Weekly Remaining", remainingFraction: 0.2 },
  ] }] };
  const requests = mockAgyQuota(t, { summary });
  const result = await fetchAntigravityUsage({ credential: { token: { access_token: "test-access" } }, force: true });
  assert.deepEqual(result.gauges, normalizeAgyQuota(summary));
  assert.equal(requests.some(({ url }) => url.endsWith(":fetchAvailableModels")), false);
});

test("a failed optional Gemini request preserves the existing partner quota", async (t) => {
  mockAgyQuota(t, { modelStatus: 503 });
  const result = await fetchAntigravityUsage({ credential: { token: { access_token: "test-access" } }, force: true });
  assert.deepEqual(result.gauges, normalizeAgyQuota(partnerQuota));
});

test("Gemini authentication failures use the existing credential refresh and retry path", async (t) => {
  clearUsageCache(); t.after(() => clearUsageCache());
  const current = { token: { access_token: "refreshed", refresh_token: "same-account" } };
  const headers = [];
  t.mock.method(global, "fetch", async (url, options) => {
    if (url.includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    if (url.endsWith(":loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: "projects/test" });
    if (url.endsWith(":retrieveUserQuotaSummary")) return jsonResponse(partnerQuota);
    if (url.endsWith(":fetchAvailableModels")) {
      headers.push(options.headers.authorization);
      return jsonResponse(geminiModels, options.headers.authorization === "Bearer refreshed" ? 200 : 401);
    }
    throw new Error("Unexpected endpoint");
  });
  const result = await fetchAntigravityUsage({
    credential: { token: { access_token: "expired", refresh_token: "same-account" } }, force: true,
    credentialStore: { read: async () => current, write: () => { throw new Error("Already refreshed; must not write"); } },
  });
  assert.deepEqual(headers, ["Bearer expired", "Bearer refreshed"]);
  assert.equal(result.gauges.at(-1).label, "Gemini");
});

test("AGY 한도는 남은 비율을 사용률로 바꾸고 잘못된 bucket은 제외한다", () => {
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [
        {
          displayName: "모델",
          buckets: [
            { displayName: "주간", remainingFraction: 0.25, resetTime: "soon" },
            { displayName: "누락" },
            { displayName: "null", remainingFraction: null },
            { displayName: "빈 값", remainingFraction: "" },
          ],
        },
      ],
    }),
    [{ label: "모델 · 주간", usedPercent: 75, resetText: "soon" }]
  );
});

test("Claude 한도는 전체 및 모델별 창을 표시하고 범위를 보정한다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
    seven_day_opus: { utilization: null },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일", "7일 · Sonnet"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100, 25]);
});

test("AGY 응답에서 계정, 플랜, 한도만 정규화한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return jsonResponse({
        cloudaicompanionProject: "projects/test",
        currentTier: { displayName: "Antigravity" },
        paidTier: { name: "Google AI Pro" },
      });
    }
    if (String(url).includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    return jsonResponse({
      groups: [{ displayName: "모델", buckets: [{ displayName: "5시간", remainingFraction: 0.8 }] }],
    });
  };

  const result = await fetchAntigravityUsage({
    credential: { token: { access_token: "access", refresh_token: "refresh" } },
    force: true,
  });
  assert.equal(result.email, "agy@example.com");
  assert.equal(result.plan, "Google AI Pro");
  assert.equal(result.gauges[0].usedPercent, 20);
  assert.equal(tierLabel({ currentTier: { name: "free-tier" } }), "free-tier");
});

test("Grok billing 로그에서 구독 플랜과 주간 한도를 읽는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-usage-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logDir = path.join(home, ".grok", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.parse("2026-08-08T00:00:00Z");
  const entry = {
    ts: "2026-08-07T23:59:30Z",
    msg: "billing: fetched credits config",
    ctx: {
      subscriptionTier: "SuperGrok Plus",
      config: {
        creditUsagePercent: 5,
        currentPeriod: { end: "2026-08-14T00:00:00Z" },
      },
    },
  };
  fs.writeFileSync(
    path.join(logDir, "unified.jsonl"),
    `${JSON.stringify({ msg: "unrelated" })}\n${JSON.stringify(entry)}\n`
  );

  assert.deepEqual(normalizeGrokUsage(entry), {
    provider: "grok",
    plan: "SuperGrok Plus",
    gauges: [{ label: "주간 한도", usedPercent: 5, resetText: "2026-08-14T00:00:00Z" }],
  });
  assert.deepEqual(readGrokUsage({ home, env: {}, now }), normalizeGrokUsage(entry));
});

test("Grok billing 로그가 오래됐으면 현재 한도로 표시하지 않는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-stale-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logDir = path.join(home, ".grok", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "unified.jsonl"), JSON.stringify({
    ts: "2026-08-07T20:00:00Z",
    msg: "billing: fetched credits config",
    ctx: { subscriptionTier: "SuperGrok Plus", config: { creditUsagePercent: 5 } },
  }));
  assert.throws(
    () => readGrokUsage({ home, env: {}, now: Date.parse("2026-08-08T00:00:00Z") }),
    /오래되어/
  );
});

test("Claude 사용량 cache는 계정 자격 증명별로 분리한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-usage-"));
  const credentialPath = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ five_hour: { utilization: calls * 10, resets_at: "soon" } });
  };

  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "account-a" } })
  );
  await fetchClaudeUsage({ home });
  await fetchClaudeUsage({ home });
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "b", refreshToken: "account-b" } })
  );
  await fetchClaudeUsage({ home });
  assert.equal(calls, 2);
});
