import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const assets = [
  ["src/hook-system/opencode-plugin.template.ts", "dist/hook-system/opencode-plugin.template.js"],
];

for (const [src, dest] of assets) {
  const srcPath = resolve(root, src);
  const destPath = resolve(root, dest);
  if (!existsSync(srcPath)) {
    console.warn(`[copy-assets] skip missing: ${src}`);
    continue;
  }
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[copy-assets] ${src} -> ${dest}`);
}
