document.title = "CodePet 남은 한도";
const api = window.usageApi;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const remainingPercent = (used) => typeof used === "number" && Number.isFinite(used) ? Math.round(100 - Math.max(0, Math.min(100, used))) : null;
const tone = (value) => value == null ? "" : value <= 10 ? "critical" : value <= 30 ? "warning" : "";
function resetLabel(value) {
  if (!value) return "초기화 시각 미제공";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toLocaleString("ko-KR", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" })} 초기화`;
}
function intervalLabel(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  return minutes >= 1 ? `${minutes}분마다 자동 갱신` : "자동 갱신";
}
function render(data) {
  if (!data) return;
  const rows = data.providers.filter((p) => p.connected);
  const loading = data.providers.some((p) => p.loading);
  const container = document.getElementById("providers");
  container.replaceChildren();
  if (!rows.length) container.append(element("p", "empty", loading ? "로그인 상태 확인 중…" : "로그인된 서비스가 없습니다."));
  for (const row of rows) {
    const card = element("article", "usage-card");
    const heading = element("header", "usage-card-heading");
    const identity = element("div", "card-identity");
    identity.append(element("h2", "", row.label));
    if (row.account) identity.append(element("small", "", row.account));
    heading.append(element("span", "provider-mark", row.label.slice(0, 1)), identity);
    if (row.plan) heading.append(element("span", "count-label", row.plan));
    card.append(heading);
    for (const gauge of row.gauges) {
      const value = remainingPercent(gauge.usedPercent);
      const group = element("div", `gauge ${tone(value)}`);
      const label = element("div", "usage-row");
      const name = element("span", "", gauge.label);
      name.title = gauge.label;
      label.append(name, element("strong", "", value == null ? "—" : `${value}% 남음`));
      group.append(label);
      if (value != null) {
        const bar = element("progress", "usage-track"); bar.max = 100; bar.value = value; bar.setAttribute("aria-label", `${row.label} ${gauge.label} 남은 한도`);
        group.append(bar);
      }
      group.append(element("small", "", resetLabel(gauge.resetText)));
      card.append(group);
    }
    if (row.error) card.append(element("p", "usage-error", row.stale ? `${row.error} · 이전 조회값` : row.error));
    if (row.updatedAt) card.append(element("p", "card-meta", `${new Date(row.updatedAt).toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })} 기준${row.loading ? " · 갱신 중…" : ""}`));
    container.append(card);
  }
  const disconnected = data.providers.filter((p) => !p.connected && !p.loading);
  if (disconnected.length) container.append(element("p", "disconnected", disconnected.map((p) => `${p.label}: ${p.error || "로그인 필요"}`).join(" · ")));
  document.getElementById("refresh").disabled = loading;
  document.getElementById("status").textContent = loading ? "한도 확인 중…" : intervalLabel(data.intervalMs);
}
for (const [id, action] of [["close","close"],["accounts","settings"]]) {
  document.getElementById(id).addEventListener("click", () => api?.action(action));
}
document.getElementById("refresh").addEventListener("click", async () => {
  const button = document.getElementById("refresh"); button.disabled = true;
  try { render(await api.refresh()); } catch { document.getElementById("status").textContent = "새로고침 실패"; }
  finally { button.disabled = false; }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") api?.action("close"); });
if (api) { api.onUpdate(render); api.get().then(render).catch(() => {}); }
