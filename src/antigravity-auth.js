const { createAntigravityCredentialStore } = require("./antigravity-credential");
const { resolveAntigravityClient } = require("./antigravity-oauth-client");

const refreshes = new Map();
const liveStore = createAntigravityCredentialStore();
const defaultStore = {
  read: async () => JSON.parse(await liveStore.read()),
  write: (value, options) => liveStore.write(value, options),
};

function clientId(credential) {
  // The installed app's ID token identifies the OAuth client that issued this
  // refresh token. It is metadata here, not proof of identity or authorization.
  try {
    const claims = JSON.parse(Buffer.from(credential.id_token.split(".")[1], "base64url").toString("utf8"));
    if (typeof claims.aud === "string" && /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(claims.aud)) {
      return claims.aud;
    }
  } catch { /* A missing client requires a fresh login in Antigravity. */ }
  throw new Error("AGY 인증 정보를 갱신할 수 없습니다. Antigravity에서 다시 로그인해 주세요.");
}

function expired(credential) {
  const expiry = Date.parse(credential?.token?.expiry);
  return Number.isFinite(expiry) && expiry <= Date.now() + 60000;
}

async function refreshAntigravityCredential(credential, { store = defaultStore, fetchImpl = fetch, resolveClient = resolveAntigravityClient } = {}) {
  const refreshToken = credential?.token?.refresh_token;
  if (!refreshToken) throw new Error("AGY 로그인 정보가 만료됐습니다. Antigravity에서 다시 로그인해 주세요.");
  let pending = refreshes.get(refreshToken);
  if (!pending) {
    pending = (async () => {
      const current = await store.read();
      if (current?.token?.refresh_token !== refreshToken) {
        throw new Error("AGY 계정이 변경됐습니다. 다시 조회해 주세요.");
      }
      // Another request or Antigravity itself may already have refreshed it.
      if (current.token.access_token !== credential.token.access_token && !expired(current)) return current;
      const audience = clientId(current);
      const client = await resolveClient(audience);
      if (!client?.clientSecret || client.clientId !== audience) throw new Error("AGY 인증 갱신 설정을 찾지 못했습니다. Antigravity를 업데이트하고 다시 로그인해 주세요.");
      const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const error = new Error(`AGY 인증 갱신에 실패했습니다 (HTTP ${response.status}). Antigravity에서 다시 로그인해 주세요.`);
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (typeof data.access_token !== "string" || !data.access_token || !(Number(data.expires_in) > 0)) {
        throw new Error("AGY 인증 갱신 응답이 올바르지 않습니다.");
      }
      const next = {
        ...current,
        ...(data.id_token ? { id_token: data.id_token } : {}),
        token: {
          ...current.token,
          access_token: data.access_token,
          refresh_token: data.refresh_token || refreshToken,
          token_type: data.token_type || current.token.token_type,
          expiry: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString(),
        },
      };
      const latest = await store.read();
      if (latest?.token?.refresh_token !== refreshToken) {
        throw new Error("AGY 계정이 변경됐습니다. 다시 조회해 주세요.");
      }
      if (latest.token.access_token !== current.token.access_token && !expired(latest)) return latest;
      await store.write(next, { expectedRefreshToken: refreshToken });
      return next;
    })();
    refreshes.set(refreshToken, pending);
    pending.finally(() => {
      if (refreshes.get(refreshToken) === pending) refreshes.delete(refreshToken);
    }).catch(() => {});
  }
  const next = await pending;
  Object.assign(credential, next);
  return credential;
}

async function withAntigravityCredential(credential, request, options = {}) {
  if (!credential?.token?.access_token) throw new Error("AGY 로그인 정보가 없습니다.");
  let refreshed = false;
  if (expired(credential) && credential.token.refresh_token) {
    await refreshAntigravityCredential(credential, options);
    refreshed = true;
  }
  try {
    return await request(credential.token.access_token);
  } catch (error) {
    if (error.status !== 401 || refreshed || !credential.token.refresh_token) throw error;
    await refreshAntigravityCredential(credential, options);
    return request(credential.token.access_token);
  }
}

module.exports = { refreshAntigravityCredential, withAntigravityCredential };
