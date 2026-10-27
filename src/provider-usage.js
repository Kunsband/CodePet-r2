const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClaudeFileStore } = require("./claude-live-credentials");
const { withAntigravityCredential } = require("./antigravity-auth");

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const cache = new Map();

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function tokenKey(provider, token) {
  const digest = crypto.createHash("sha256").update(String(token || "none")).digest("hex").slice(0, 16);
  return `${provider}:${digest}`;
}

async function cached(key, load, { ttl = 60000, force = false } = {}) {
  const old = cache.get(key);
  if (!force && old && Date.now() - old.at < ttl) return old.value;
  const value = Promise.resolve().then(load);
  cache.set(key, { at: Date.now(), value });
  try {
    return await value;
  } catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}

function clearUsageCache(provider = null) {
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) cache.delete(key);
  }
}

function normalizeAgyQuota(data) {
  return (data?.groups || []).flatMap((group) =>
    (group.buckets || []).flatMap((bucket) => {
      const raw = bucket.remainingFraction ?? bucket.remaining_fraction;
      if (raw == null || raw === "") return [];
      const remaining = Number(raw);
      if (!Number.isFinite(remaining)) return [];
      return [{
        label: [group.displayName || group.name, String(bucket.displayName || bucket.window || "").replace(/\s+Remaining$/i, "")]
          .filter(Boolean)
          .join(" · "),
        usedPercent: clampPercent((1 - remaining) * 100),
        resetText: bucket.resetTime || bucket.reset_time || "",
      }];
    })
  );
}

function normalizeAgyGeminiQuota(data) {
  const models = Object.entries(data?.models || {}).filter(([id, model]) =>
    model && !model.isInternal && (/^gemini(?:-|$)/i.test(id) || /^gemini\b/i.test(model.displayName || ""))
  );
  const tieredIds = new Set(Object.values(data?.tieredModelIds || {})
    .flatMap((ids) => Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []));
  const tiered = models.filter(([id]) => tieredIds.has(id));
  // Prefer the current tier's model IDs over legacy aliases. Older responses
  // without this catalog can still expose named, public Gemini models.
  const candidates = tiered.length ? tiered : models.filter(([, model]) => model.displayName);
  const gauges = candidates.flatMap(([id, model]) => {
    const quota = model.quotaInfo || model.quota_info;
    const raw = quota?.remainingFraction ?? quota?.remaining_fraction;
    if (!["number", "string"].includes(typeof raw) || String(raw).trim() === "") return [];
    const remaining = Number(raw);
    if (!Number.isFinite(remaining)) return [];
    return [{ label: model.displayName || id,
      usedPercent: clampPercent((1 - remaining) * 100),
      resetText: quota.resetTime || quota.reset_time || "" }];
  });
  if (!gauges.length) return [];
  const first = gauges[0];
  // Shared Gemini quotas need one row. Preserve distinct balances/reset times
  // when the backend returns different model limits.
  if (gauges.every((gauge) => gauge.usedPercent === first.usedPercent && gauge.resetText === first.resetText)) {
    return [{ ...first, label: "Gemini" }];
  }
  return [...new Map(gauges.map((gauge) => [JSON.stringify(gauge), gauge])).values()];
}

function normalizeClaudeUsage(data) {
  const windows = [
    ["5시간", data?.five_hour],
    ["7일", data?.seven_day],
    ["7일 · Sonnet", data?.seven_day_sonnet],
    ["7일 · Opus", data?.seven_day_opus],
  ];
  return windows.flatMap(([label, value]) => {
    if (value?.utilization == null || value.utilization === "") return [];
    const utilization = Number(value?.utilization);
    if (!Number.isFinite(utilization)) return [];
    return [{
      label,
      usedPercent: clampPercent(utilization),
      resetText: value.resets_at || "",
    }];
  });
}

function normalizeGrokUsage(entry) {
  const config = entry?.ctx?.config || {};
  const usedPercent = Number(config.creditUsagePercent);
  const plan = typeof entry?.ctx?.subscriptionTier === "string"
    ? entry.ctx.subscriptionTier.trim()
    : "";
  const gauges = Number.isFinite(usedPercent)
    ? [{
      label: "주간 한도",
      usedPercent: clampPercent(usedPercent),
      resetText: config.currentPeriod?.end || config.billingPeriodEnd || "",
    }]
    : [];
  if (!plan && gauges.length === 0) return null;
  return { provider: "grok", plan: plan || null, gauges };
}

function readGrokUsage({
  home = os.homedir(),
  env = process.env,
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const grokHome = env.GROK_HOME || path.join(home, ".grok");
  const logPath = path.join(grokHome, "logs", "unified.jsonl");
  const stat = fs.statSync(logPath);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const file = fs.openSync(logPath, "r");
  try {
    fs.readSync(file, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(file);
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (stat.size > length) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry?.msg !== "billing: fetched credits config") continue;
    const timestamp = Date.parse(entry.ts);
    if (Number.isFinite(timestamp) && now - timestamp > maxAgeMs) {
      throw new Error("Grok 한도 정보가 오래되어 다시 조회해야 합니다.");
    }
    const usage = normalizeGrokUsage(entry);
    if (usage) return usage;
  }
  throw new Error("Grok 한도 정보를 찾지 못했습니다.");
}

async function json(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(`사용량 서버가 HTTP ${response.status}를 반환했습니다.`, response.status);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshClaudeOAuth(credentials, store) {
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) throw new Error("Claude 로그인 정보가 만료됐습니다.");
  const refresh = await json("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const expiresAt = Number(refresh.expires_at) ||
    (Number(refresh.expires_in) ? Date.now() + Number(refresh.expires_in) * 1000 : oauth.expiresAt);
  const next = {
    ...oauth,
    accessToken: refresh.access_token || oauth.accessToken,
    refreshToken: refresh.refresh_token || oauth.refreshToken,
    expiresAt,
  };
  credentials.claudeAiOauth = next;
  store.write(credentials);
  return next;
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  if (!credentials) throw new Error("Claude 로그인 정보가 없습니다.");
  let oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude 로그인 정보가 없습니다.");
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
    // refreshToken이 없는 자격 증명(데스크톱 앱 관리 인증)은 현재 accessToken으로 그대로 시도합니다.
    if (oauth.refreshToken && oauth.expiresAt && Number(oauth.expiresAt) <= Date.now() + 60000) {
      oauth = await refreshClaudeOAuth(credentials, store);
    }

    const request = () => json("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    let data;
    try {
      data = await request();
    } catch (error) {
      if (error.status !== 401 || !oauth.refreshToken) throw error;
      oauth = await refreshClaudeOAuth(credentials, store);
      data = await request();
    }
    return { provider: "claude", gauges: normalizeClaudeUsage(data) };
  }, { force });
}

function tierLabel(assist) {
  const tier = assist?.paidTier || assist?.paid_tier || assist?.currentTier || assist?.current_tier || null;
  if (typeof tier === "string") return tier;
  return tier?.displayName || tier?.display_name || tier?.name || tier?.id || null;
}

// agy CLI처럼 Go 형식의 OS/아키텍처 이름을 보냅니다.
const AGY_USER_AGENT = `antigravity/cli/1.0.11 ${process.platform === "win32" ? "windows" : process.platform}/${
  process.arch === "x64" ? "amd64" : process.arch}`;

async function fetchAntigravityUsage({ credential, force = false, credentialStore } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy", credential?.token?.refresh_token || token);

  return cached(key, () => withAntigravityCredential(credential, async (accessToken) => {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "user-agent": AGY_USER_AGENT,
    };
    const [assist, identity] = await Promise.all([
      json("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
      }),
      fetchAntigravityIdentity({ credential, credentialStore }).catch(() => ({})),
    ]);
    const projectValue = assist?.cloudaicompanionProject;
    const project = typeof projectValue === "string" ? projectValue : projectValue?.id;
    if (!project) throw new Error("AGY 프로젝트 정보를 찾지 못했습니다.");
    const quota = await json(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ project }),
      }
    );
    const gauges = normalizeAgyQuota(quota);
    if (!gauges.some((gauge) => /\bgemini\b/i.test(gauge.label))) {
      try {
        const models = await json("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
          method: "POST", headers, body: JSON.stringify({ project }),
        });
        gauges.push(...normalizeAgyGeminiQuota(models));
      } catch (error) {
        // Let the existing credential handler retry an expired token. Other
        // optional-model failures must not discard the working summary quota.
        if (error.status === 401) throw error;
      }
    }
    return {
      provider: "agy",
      email: identity.email || null,
      plan: tierLabel(assist),
      gauges,
    };
  }, { store: credentialStore }), { force });
}

async function fetchAntigravityIdentity({ credential, force = false, credentialStore } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new Error("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy:identity", credential?.token?.refresh_token || token);
  return cached(key, () => withAntigravityCredential(credential, async (accessToken) => {
    const identity = await json("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return { email: identity?.email || null };
  }, { store: credentialStore }), { force });
}

module.exports = {
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeAgyGeminiQuota,
  normalizeClaudeUsage,
  normalizeGrokUsage,
  readGrokUsage,
  tierLabel,
};
