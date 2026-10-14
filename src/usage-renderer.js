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
function render(data) {
  if (!data) return;
  const rows = data.providers.filter((p) => p.connected);
  const loading = data.providers.some((p) => p.loading);
  const container = document.getElementById("providers");
  container.replaceChildren();
  if (!rows.length) container.append(element("p", "empty", loading ? "로그인 상태 확인 중…" : "로그인된 서비스가 없습니다."));
  for (const row of rows) {
    const section = element("section", "provider");
    const title = element("div", "provider-title");
    title.append(element("h2", "", row.label), element("span", "plan", row.plan));
    section.append(title, element("p", "account", row.account));
    for (const gauge of row.gauges) {
      const value = remainingPercent(gauge.usedPercent);
      const group = element("div", `gauge ${tone(value)}`);
      const label = element("div", "gauge-label");
      label.append(element("span", "", gauge.label), element("strong", "", value == null ? "—" : `${value}% 남음`));
      group.append(label);
      if (value != null) {
        const bar = element("progress"); bar.max = 100; bar.value = value; bar.setAttribute("aria-label", `${row.label} ${gauge.label} 남은 한도`);
        group.append(bar);
      }
      group.append(element("p", "reset", resetLabel(gauge.resetText)));
      section.append(group);
    }
    if (row.error) section.append(element("p", "error", row.stale ? `${row.error} · 이전 조회값` : row.error));
    if (row.updatedAt) section.append(element("p", "updated", `${new Date(row.updatedAt).toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })} 기준${row.loading ? " · 갱신 중…" : ""}`));
    container.append(section);
  }
  const disconnected = data.providers.filter((p) => !p.connected && !p.loading);
  if (disconnected.length) container.append(element("p", "updated", disconnected.map((p) => `${p.label}: ${p.error || "로그인 필요"}`).join(" · ")));
  document.getElementById("refresh").disabled = loading;
  document.getElementById("status").textContent = loading ? "한도 확인 중…" : "5분마다 자동 갱신";
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
