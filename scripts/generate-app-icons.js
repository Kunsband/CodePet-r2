// Run with Electron; preserve the supplied source and generate packaging sizes.
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const root = path.join(__dirname, "..");
const source = nativeImage.createFromPath(path.join(root, "build", "icon-source.png"));
if (source.isEmpty()) throw new Error("Missing build/icon-source.png");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => source.resize({ width: size, height: size, quality: "best" }).toPNG());
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const entry = 6 + i * 16, size = sizes[i];
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(root, "build", "icon.ico"), Buffer.concat([header, ...images]));
fs.writeFileSync(path.join(root, "build", "icon.png"), source.resize({ width: 512, height: 512, quality: "best" }).toPNG());
fs.writeFileSync(path.join(root, "build", "icon-mac.png"), source.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
console.log("Generated app/tray icons from build/icon-source.png (16–1024px).");
app.quit();
