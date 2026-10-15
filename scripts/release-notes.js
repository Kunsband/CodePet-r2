const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const sections = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")
  .replace(/\r\n/g, "\n").split(/^## /m);
const section = sections.find((entry) => entry.startsWith(`${version} — `));
if (!section) throw new Error(`Release notes missing for ${version}`);
process.stdout.write(section.slice(section.indexOf("\n") + 1).trim() + "\n");
