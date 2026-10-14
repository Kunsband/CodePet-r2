const fs = require("node:fs/promises");
const path = require("node:path");

// Installed-app OAuth metadata is shipped with Antigravity. Read the matching
// client locally; never bundle its secret or guess a different client's pair.
function clientFromPE(buffer, clientId) {
  try {
    if (buffer.toString("ascii", 0, 2) !== "MZ") return null;
    const pe = buffer.readUInt32LE(0x3c);
    if (buffer.toString("ascii", pe, pe + 4) !== "PE\0\0") return null;
    const count = buffer.readUInt16LE(pe + 6);
    const optional = pe + 24;
    if (buffer.readUInt16LE(optional) !== 0x20b) return null;
    const imageBase = buffer.readBigUInt64LE(optional + 24);
    const table = optional + buffer.readUInt16LE(pe + 20);
    const sections = [];
    for (let i = 0; i < count; i += 1) {
      const at = table + i * 40;
      sections.push({ rva: buffer.readUInt32LE(at + 12), size: buffer.readUInt32LE(at + 16), raw: buffer.readUInt32LE(at + 20) });
    }
    const fileOffset = (address, length) => {
      const rva = Number(address - imageBase);
      const section = sections.find((s) => rva >= s.rva && rva + length <= s.rva + s.size);
      return section ? section.raw + rva - section.rva : -1;
    };
    // Windows Go builds may initialize the config in code instead of a static
    // record: ClientID at +0/+8, ClientSecret at +16/+24 of the same object.
    const initPrefix = Buffer.from([0x48, 0xc7, 0x40, 0x08, clientId.length, 0, 0, 0, 0x48, 0x8d, 0x0d]);
    for (let init = buffer.indexOf(initPrefix); init >= 0; init = buffer.indexOf(initPrefix, init + 1)) {
      if (init + 37 > buffer.length) continue;
      if (buffer.subarray(init + 15, init + 29).toString("hex") !== "48890848c7401823000000488d0d"
        || buffer.subarray(init + 33, init + 37).toString("hex") !== "48894810") continue;
      const section = sections.find((s) => init >= s.raw && init + 37 <= s.raw + s.size);
      if (!section) continue;
      const instructionAddress = imageBase + BigInt(section.rva + init - section.raw);
      const idOffset = fileOffset(instructionAddress + 15n + BigInt(buffer.readInt32LE(init + 11)), clientId.length);
      const secretOffset = fileOffset(instructionAddress + 33n + BigInt(buffer.readInt32LE(init + 29)), 35);
      if (idOffset < 0 || secretOffset < 0 || buffer.toString("ascii", idOffset, idOffset + clientId.length) !== clientId) continue;
      const secret = buffer.toString("ascii", secretOffset, secretOffset + 35);
      if (/^GOCSPX-[A-Za-z0-9_-]{28}$/.test(secret)) return { clientId, clientSecret: secret };
    }
    for (let at = buffer.indexOf(clientId); at >= 0; at = buffer.indexOf(clientId, at + 1)) {
      const section = sections.find((s) => at >= s.raw && at + clientId.length <= s.raw + s.size);
      if (!section) continue;
      const pointer = Buffer.alloc(8);
      pointer.writeBigUInt64LE(imageBase + BigInt(section.rva + at - section.raw));
      for (let record = buffer.indexOf(pointer); record >= 0; record = buffer.indexOf(pointer, record + 1)) {
        // Go OAuth config stores consecutive string (pointer, length) pairs.
        if (record + 32 > buffer.length || buffer.readBigUInt64LE(record + 8) !== BigInt(clientId.length)
          || buffer.readBigUInt64LE(record + 24) !== 35n) continue;
        const offset = fileOffset(buffer.readBigUInt64LE(record + 16), 35);
        if (offset < 0 || offset + 35 > buffer.length) continue;
        const secret = buffer.toString("ascii", offset, offset + 35);
        if (/^GOCSPX-[A-Za-z0-9_-]{28}$/.test(secret)) return { clientId, clientSecret: secret };
      }
    }
  } catch { /* Unknown or incomplete installed binary; require login instead. */ }
  return null;
}

const clients = new Map();
async function resolveAntigravityClient(clientId, { env = process.env, platform = process.platform } = {}) {
  if (env.ANTIGRAVITY_OAUTH_CLIENT_ID === clientId && env.ANTIGRAVITY_OAUTH_CLIENT_SECRET) {
    return { clientId, clientSecret: env.ANTIGRAVITY_OAUTH_CLIENT_SECRET };
  }
  if (platform !== "win32") return null;
  const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "antigravity"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Antigravity")].filter(Boolean);
  for (const root of roots) {
    const file = path.join(root, "resources", "bin", "language_server.exe");
    try {
      const stat = await fs.stat(file);
      const key = `${file}:${stat.mtimeMs}:${clientId}`;
      if (clients.has(key)) return clients.get(key);
      const client = clientFromPE(await fs.readFile(file), clientId);
      if (client) { clients.clear(); clients.set(key, client); return client; }
    } catch { /* Try the other installed location. */ }
  }
  return null;
}

module.exports = { clientFromPE, resolveAntigravityClient };
