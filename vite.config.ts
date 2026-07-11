import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve("src/viewer-ui"),
  plugins: [react()],
  build: {
    outDir: resolve("dist/viewer/ui"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
