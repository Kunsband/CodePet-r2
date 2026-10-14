const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTaskbar } = require("../src/windows-taskbar");
let attached = false;
const host = createTaskbar({ icon: fs.readFileSync(path.join(__dirname, "..", "build", "icon.png")),
  onDiagnostic(message) { console.error(message); },
  onClick(bounds) { console.log("CLICK", bounds); },
  onStatus(event) {
    console.log(event);
    if (event.type === "attached") { assert.equal(event.attached, true); assert.equal(event.visible, true); assert.equal(event.child, true); assert.equal(event.rendered, true); assert.equal(event.renderError, 0); assert.ok(event.parent > 0); attached = true; }
  },
});
host.update({ providers: [
  { label: "Codex", connected: true, gauges: [{ usedPercent: 23 }] },
  { label: "AGY", connected: true, gauges: [{ usedPercent: 0 }] },
  { label: "Claude", connected: true, gauges: [{ usedPercent: 22 }] },
] });
setTimeout(() => { if (!attached) { host.dispose(); process.exitCode = 1; console.error("Taskbar did not attach"); } }, 15000);
setTimeout(() => { host.dispose(); console.log(attached ? "PASS: native attachment and surface submission verified; visual check still required" : "FAIL"); }, process.argv.includes("--hold") ? 180000 : 17000);
