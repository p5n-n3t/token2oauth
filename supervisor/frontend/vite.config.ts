import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { "$lib": resolve(here, "src/lib") },
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    css: true,
  },
  build: {
    outDir: "./dist",
    emptyOutDir: true,
    assetsDir: "assets/ui",
    sourcemap: false,
  },
});
