const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

function taskbarRows(snapshot) {
  return (snapshot?.providers || []).filter((row) => row.connected).slice(0, 4).map((row) => {
    const values = (row.gauges || []).map((g) => g.usedPercent).filter((v) => typeof v === "number" && Number.isFinite(v));
    return { label: String(row.label).slice(0, 12), remainingPercent: values.length ? Math.round(100 - Math.max(0, Math.min(100, Math.max(...values)))) : null, stale: Boolean(row.stale) };
  });
}

function createTaskbar({ onClick, onStatus = () => {}, onDiagnostic = () => {}, icon, platform = process.platform }) {
  let child, retryTimer, stopped = false, failures = 0, bounds = null;
  let state = { visible: true, offset: 0, rows: [], icon: icon?.toString("base64") };
  const send = () => { if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(state)}\n`); };
  function launch() {
    if (stopped || platform !== "win32") return;
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))); [CodePetTaskbar]::Run()";
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.on("error", () => onStatus({ type: "unavailable" }));
    // Never log the full command or user/account data; protocol contains summary percentages only.
    child.stderr.on("data", (data) => { onStatus({ type: "host-error" }); onDiagnostic(data.toString().slice(0, 3000)); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (!event.attached) return;
        if (![event.x, event.y, event.width, event.height].every(Number.isFinite)) return;
        bounds = { x: event.x, y: event.y, width: event.width, height: event.height };
        if (event.type === "click") onClick(bounds);
        if (event.type === "attached") { failures = 0; onStatus(event); }
      } catch { }
    });
    child.once("exit", () => {
      lines.close(); child = null; bounds = null;
      if (!stopped && ++failures <= 3) retryTimer = setTimeout(launch, failures * 2000);
    });
    child.stdin.write(`${fs.readFileSync(path.join(__dirname, "windows-taskbar-host.cs")).toString("base64")}\n`);
    send();
  }
  launch();
  return {
    update(snapshot) { state = { ...state, rows: taskbarRows(snapshot) }; send(); },
    setVisible(visible) { state = { ...state, visible }; send(); },
    resetPosition() { state = { ...state, offset: 0 }; send(); },
    getBounds() { return bounds; },
    dispose() { stopped = true; clearTimeout(retryTimer); child?.stdin.end(); const closing = child; if (closing) { const timer = setTimeout(() => closing.kill(), 2000); timer.unref(); } },
  };
}
module.exports = { createTaskbar, taskbarRows };
