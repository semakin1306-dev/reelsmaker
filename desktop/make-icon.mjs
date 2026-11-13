// Значок ReelsMaker из desktop/icon.svg: ICO для ярлыка Windows и PNG/SVG для окна интерфейса.
// Рендер — Chromium из Playwright (путь к его index.mjs — RM_PLAYWRIGHT, иначе пакет playwright).
// В контейнер ICO кладутся PNG-кадры (Windows Vista+ читает их на любом размере).
//   node desktop/make-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "apps", "hub", "public");
const PW = process.env.RM_PLAYWRIGHT || "playwright";
const { chromium } = await import(pathToFileURL(PW).href);

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svg = fs.readFileSync(path.join(HERE, "icon.svg"));

async function render(pg, size) {
  await pg.setViewportSize({ width: size, height: size });
  await pg.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg.toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`);
  return pg.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

function ico(frames) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let off = 6 + dir.length;
  frames.forEach((f, i) => {
    const e = i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e);
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(f.png.length, e + 8);
    dir.writeUInt32LE(off, e + 12);
    off += f.png.length;
  });
  return Buffer.concat([head, dir, ...frames.map((f) => f.png)]);
}

const br = await chromium.launch();
const pg = await br.newPage({ deviceScaleFactor: 1 });
try {
  const frames = [];
  for (const s of ICO_SIZES) frames.push({ size: s, png: await render(pg, s) });
  fs.writeFileSync(path.join(HERE, "reelsmaker.ico"), ico(frames));
  console.log("reelsmaker.ico: " + ICO_SIZES.join(", ") + " px");
  fs.writeFileSync(path.join(PUBLIC, "icon-192.png"), await render(pg, 192));
  fs.copyFileSync(path.join(HERE, "icon.svg"), path.join(PUBLIC, "icon.svg"));
  console.log("apps/hub/public: icon.svg, icon-192.png");
} finally {
  await br.close();
}
