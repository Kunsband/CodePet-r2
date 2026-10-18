const fs = require("node:fs/promises");
const os = require("node:os");
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
    const address = (at) => {
      const section = sections.find((s) => at >= s.raw && at + clientId.length <= s.raw + s.size);
      return section ? imageBase + BigInt(section.rva + at - section.raw) : null;
    };
    return staticClient(buffer, clientId, address, fileOffset);
  } catch { /* Unknown or incomplete installed binary; require login instead. */ }
  return null;
}

// Go OAuth config stores consecutive string (pointer, length) pairs.
function staticClient(buffer, clientId, address, fileOffset) {
  for (let at = buffer.indexOf(clientId); at >= 0; at = buffer.indexOf(clientId, at + 1)) {
    const target = address(at);
    if (target === null) continue;
    const pointer = Buffer.alloc(8);
    pointer.writeBigUInt64LE(target);
    for (let record = buffer.indexOf(pointer); record >= 0; record = buffer.indexOf(pointer, record + 1)) {
      if (record + 32 > buffer.length || buffer.readBigUInt64LE(record + 8) !== BigInt(clientId.length)
        || buffer.readBigUInt64LE(record + 24) !== 35n) continue;
      const offset = fileOffset(buffer.readBigUInt64LE(record + 16), 35);
      if (offset < 0 || offset + 35 > buffer.length) continue;
      const secret = buffer.toString("ascii", offset, offset + 35);
      if (/^GOCSPX-[A-Za-z0-9_-]{28}$/.test(secret)) return { clientId, clientSecret: secret };
    }
  }
  return null;
}

const MACHO_CPU = { arm64: 0x0100000c, x64: 0x01000007 };

// macOS Go builds are Mach-O; universal binaries hold one slice per CPU.
function clientFromMachO(buffer, clientId, arch = process.arch) {
  try {
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xcafebabe) {
      const count = buffer.readUInt32BE(4);
      const slices = [];
      for (let i = 0; i < count; i += 1) {
        const at = 8 + i * 20;
        slices.push({ cpu: buffer.readUInt32BE(at), offset: buffer.readUInt32BE(at + 8), size: buffer.readUInt32BE(at + 12) });
      }
      slices.sort((a, b) => (b.cpu === MACHO_CPU[arch]) - (a.cpu === MACHO_CPU[arch]));
      for (const slice of slices) {
        const client = clientFromMachO(buffer.subarray(slice.offset, slice.offset + slice.size), clientId, arch);
        if (client) return client;
      }
      return null;
    }
    if (buffer.readUInt32LE(0) !== 0xfeedfacf) return null;
    const count = buffer.readUInt32LE(16);
    const segments = [];
    let text = null;
    for (let i = 0, at = 32; i < count; i += 1) {
      const size = buffer.readUInt32LE(at + 4);
      if (buffer.readUInt32LE(at) === 0x19) {
        segments.push({ vm: buffer.readBigUInt64LE(at + 24), raw: Number(buffer.readBigUInt64LE(at + 40)),
          size: Number(buffer.readBigUInt64LE(at + 48)) });
        for (let j = 0, nsects = buffer.readUInt32LE(at + 64); j < nsects; j += 1) {
          const section = at + 72 + j * 80;
          if (buffer.toString("ascii", section, section + 16).replace(/\0.*$/s, "") !== "__text") continue;
          text = { vm: buffer.readBigUInt64LE(section + 32), size: Number(buffer.readBigUInt64LE(section + 40)),
            raw: buffer.readUInt32LE(section + 48) };
        }
      }
      at += size;
    }
    const fileOffset = (address, length) => {
      const segment = segments.find((s) => s.size && address >= s.vm && address + BigInt(length) <= s.vm + BigInt(s.size));
      return segment ? segment.raw + Number(address - segment.vm) : -1;
    };
    const address = (at) => {
      const segment = segments.find((s) => s.size && at >= s.raw && at + clientId.length <= s.raw + s.size);
      return segment ? segment.vm + BigInt(at - segment.raw) : null;
    };
    const client = staticClient(buffer, clientId, address, fileOffset);
    if (client || !text || buffer.readUInt32LE(4) !== MACHO_CPU.arm64) return client;
    return arm64Client(buffer, clientId, text, address, fileOffset);
  } catch { /* Unknown or incomplete installed binary; require login instead. */ }
  return null;
}

// arm64 Go builds may initialize the config in code: ADRP+ADD loads each
// string's address and MOVZ loads its length. Every reference to the client
// ID must pair with the same secret; disagreement means we refuse to guess.
function arm64Client(buffer, clientId, text, address, fileOffset) {
  const idAddresses = new Set();
  for (let at = buffer.indexOf(clientId); at >= 0; at = buffer.indexOf(clientId, at + 1)) {
    const target = address(at);
    if (target !== null) idAddresses.add(target);
  }
  if (!idAddresses.size) return null;
  const word = (at) => buffer.readUInt32LE(at);
  const movz = (at, length) => {
    for (let k = 1; k <= 4 && at + 4 * k + 4 <= text.raw + text.size; k += 1) {
      const insn = word(at + 4 * k);
      if ((insn & 0xffe00000) >>> 0 === 0xd2800000 && ((insn >>> 5) & 0xffff) === length) return true;
    }
    return false;
  };
  const end = text.raw + text.size - 20;
  const refs = [];
  for (let at = text.raw; at < end; at += 4) {
    const adrp = word(at);
    if ((adrp & 0x9f000000) >>> 0 !== 0x90000000) continue;
    const register = adrp & 31;
    const page = ((((adrp >>> 5) & 0x7ffff) << 2) | ((adrp >>> 29) & 3)) << 11 >> 11;
    const pc = text.vm + BigInt(at - text.raw);
    for (let k = 1; k <= 4; k += 1) {
      const add = word(at + 4 * k);
      if ((add & 0xff800000) >>> 0 !== 0x91000000 || ((add >>> 5) & 31) !== register) continue;
      const offset = BigInt(((add >>> 10) & 0xfff) * ((add >>> 22) & 1 ? 4096 : 1));
      const target = (pc & ~0xfffn) + BigInt(page) * 4096n + offset;
      refs.push({ at: at + 4 * k, target });
      break;
    }
  }
  let secret = null;
  for (let i = 0; i < refs.length; i += 1) {
    if (!idAddresses.has(refs[i].target) || !movz(refs[i].at, clientId.length)) continue;
    for (let j = i + 1; j < refs.length && refs[j].at - refs[i].at <= 128; j += 1) {
      const offset = fileOffset(refs[j].target, 35);
      if (offset < 0 || offset + 35 > buffer.length) continue;
      const value = buffer.toString("ascii", offset, offset + 35);
      if (!/^GOCSPX-[A-Za-z0-9_-]{28}$/.test(value) || !movz(refs[j].at, 35)) continue;
      if (secret && secret !== value) return null;
      secret = value;
      break;
    }
  }
  return secret ? { clientId, clientSecret: secret } : null;
}

const clients = new Map();
async function resolveAntigravityClient(clientId, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.ANTIGRAVITY_OAUTH_CLIENT_ID === clientId && env.ANTIGRAVITY_OAUTH_CLIENT_SECRET) {
    return { clientId, clientSecret: env.ANTIGRAVITY_OAUTH_CLIENT_SECRET };
  }
  const files = installedBinaries({ env, platform, home });
  const parse = platform === "win32" ? clientFromPE : clientFromMachO;
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const key = `${file}:${stat.mtimeMs}:${clientId}`;
      if (clients.has(key)) return clients.get(key);
      const client = parse(await fs.readFile(file), clientId);
      if (client) { clients.clear(); clients.set(key, client); return client; }
    } catch { /* Try the other installed location. */ }
  }
  return null;
}

function installedBinaries({ env, platform, home }) {
  if (platform === "win32") {
    return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "antigravity"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Antigravity")]
      .filter(Boolean)
      .map((root) => path.join(root, "resources", "bin", "language_server.exe"));
  }
  if (platform !== "darwin") return [];
  // The agy CLI issued the stored token, so prefer its binary over the IDE's server.
  return [
    path.join(home, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
  ];
}

module.exports = { clientFromMachO, clientFromPE, resolveAntigravityClient };
