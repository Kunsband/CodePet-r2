const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const EFFORT_ID = /^[a-z][a-z0-9_-]{0,15}$/;
const CATALOG_ERROR = "CLI에서 모델 목록을 확인하지 못했습니다. CLI 로그인 상태를 확인한 뒤 다시 탐지해 주세요.";

function cleanText(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeCatalog(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.slice(0, 500).flatMap((row) => {
    const id = row?.id;
    if (typeof id !== "string" || id === "default" || !MODEL_ID.test(id) || seen.has(id)) return [];
    seen.add(id);
    const efforts = [...new Set((Array.isArray(row.efforts) ? row.efforts : [])
      .filter((value) => typeof value === "string" && value !== "default" && EFFORT_ID.test(value)))];
    return [{ id, label: cleanText(row.label || id).slice(0, 160), efforts,
      ...(row.isDefault === true ? { isDefault: true } : {}),
      ...(efforts.includes(row.defaultEffort) ? { defaultEffort: row.defaultEffort } : {}),
    }];
  });
}

function parseClaudeModels(rows) {
  return normalizeCatalog((Array.isArray(rows) ? rows : []).map((row) => ({
    id: row?.value,
    label: row?.displayName,
    isDefault: row?.isDefault,
    efforts: row?.supportsEffort === false ? [] : row?.supportedEffortLevels,
    defaultEffort: row?.defaultEffort,
  })));
}

// AGY publishes concrete model/effort variants. Passing the returned ID is
// sufficient; a global --effort flag does not prove that a variant accepts it.
function parseAgyModels(output) {
  const rows = [];
  for (const line of cleanText(output).split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._:/-]{1,63})(?:[ \t]+(.+))?$/);
    if (!match || !/[-.\d]/.test(match[1])) continue;
    rows.push({ id: match[1], label: match[2] ? `${match[1]} · ${match[2]}` : match[1], efforts: [] });
  }
  return normalizeCatalog(rows);
}

function parseGrokCatalog(output) {
  const rows = [];
  for (const line of cleanText(output).split(/\r?\n/)) {
    const match = line.match(/^\s*\*\s+([A-Za-z0-9][A-Za-z0-9._:/-]{0,63})(?:\s+\((default)\))?\s*$/i);
    // This text catalog reports model IDs, not per-model effort support.
    if (match) rows.push({ id: match[1], isDefault: Boolean(match[2]), efforts: [] });
  }
  return normalizeCatalog(rows);
}

// Metadata handshake only: no user prompt, inference, file tools or MCP servers.
function probeClaudeModelCatalog(commandPath, needsShell, timeoutMs = 15000, options = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buffer = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.stdin.end(); } catch {}
      try {
        if (process.platform === "win32" && needsShell && child?.pid) {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => {});
        } else child?.kill();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands"];
    try {
      child = spawn(needsShell ? `"${commandPath}"` : commandPath,
        needsShell ? argv.map((arg) => arg === "" ? '""' : arg) : argv,
        { shell: Boolean(needsShell), windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: options.env, cwd: options.cwd });
    } catch { finish(null); return; }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { finish(null); return; }
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== "control_response" || message.response?.request_id !== "codepet-catalog") continue;
        const rows = message.response.subtype === "success" ? message.response.response?.models : null;
        const catalog = parseClaudeModels(rows);
        finish(catalog.length ? catalog : null);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "codepet-catalog", request: { subtype: "initialize" } })}\n`);
  });
}

function selectionError(provider, model = "default", effort = "default") {
  if (provider.catalogStatus !== "ready" || !provider.modelOptions?.length) return provider.catalogReason || CATALOG_ERROR;
  const selected = model && model !== "default" ? provider.modelOptions.find((row) => row.id === model) : null;
  if (model && model !== "default" && !selected) return "선택한 모델을 현재 CLI 목록에서 확인할 수 없습니다. 모델을 다시 선택해 주세요.";
  // Without an explicit model we cannot infer which model the CLI settings pick.
  if (effort && effort !== "default" && !selected?.efforts?.includes(effort)) {
    return "선택한 모델에서 지원 여부가 확인되지 않은 추론 단계입니다. 추론 설정을 다시 선택해 주세요.";
  }
  return "";
}

module.exports = { CATALOG_ERROR, normalizeCatalog, parseClaudeModels, parseAgyModels,
  parseGrokCatalog, probeClaudeModelCatalog, selectionError };
