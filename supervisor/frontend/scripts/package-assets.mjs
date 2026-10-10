import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(scripts, "..");
const dist = resolve(frontend, "dist");
const staticRoot = resolve(frontend, "../snooze/static");
const distEntries = await readdir(dist, { withFileTypes: true });
await mkdir(staticRoot, { recursive: true });
await rm(join(staticRoot, "assets/ui"), { recursive: true, force: true });

for (const entry of distEntries) {
  if (entry.name === "index.html") continue;
  const from = join(dist, entry.name);
  const to = join(staticRoot, entry.name);
  if (entry.isDirectory()) await cp(from, to, { recursive: true, force: true });
  else await copyFile(from, to);
}

for (const filename of [
  "THIRD_PARTY_LICENSES-kit-ui.txt",
  "THIRD_PARTY_LICENSES-agentsview.txt",
  "THIRD_PARTY_LICENSES-lucide.txt",
  "THIRD_PARTY_LICENSES-svelte.txt",
]) {
  await copyFile(join(frontend, filename), join(staticRoot, filename));
}
await copyFile(join(frontend, "OFL-fonts.txt"), join(staticRoot, "assets/ui/OFL-fonts.txt"));
await copyFile(join(frontend, "../THIRD_PARTY_NOTICES.md"), join(staticRoot, "THIRD_PARTY_NOTICES.md"));

// Publish the new entrypoint only after its hashed CSS, JS, logo and fonts exist.
await copyFile(join(dist, "index.html"), join(staticRoot, "index.html"));
await rm(join(staticRoot, "app.js"), { force: true });
await rm(join(staticRoot, "style.css"), { force: true });
