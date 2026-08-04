import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function readRepositoryProfile(workspaceRoot: string): string {
  const parts: string[] = [];
  const packagePath = join(workspaceRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
      const description = typeof pkg.description === "string" ? pkg.description : null;
      const scripts = isObject(pkg.scripts) ? Object.keys(pkg.scripts).sort() : [];
      const dependencies = isObject(pkg.dependencies) ? Object.keys(pkg.dependencies).sort().slice(0, 20) : [];
      parts.push(`Package: ${typeof pkg.name === "string" ? pkg.name : "unnamed"}${description ? ` — ${description}` : ""}`);
      if (scripts.length) parts.push(`Known commands: ${scripts.map((script) => `npm run ${script}`).join(", ")}`);
      if (dependencies.length) parts.push(`Main dependencies: ${dependencies.join(", ")}`);
    } catch { /* A malformed package file should not block the agent. */ }
  }
  const readme = ["README.md", "README.MD", "readme.md"].map((name) => join(workspaceRoot, name)).find(existsSync);
  if (readme) {
    try {
      const intro = readFileSync(readme, "utf8").replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 1_200);
      if (intro) parts.push(`Repository overview: ${intro}`);
    } catch { /* Best effort only. */ }
  }
  try {
    const entries = readdirSync(workspaceRoot).filter((name) => !name.startsWith(".") && name !== "node_modules" && name !== "dist").slice(0, 40);
    const directories = entries.filter((name) => { try { return statSync(join(workspaceRoot, name)).isDirectory(); } catch { return false; } });
    const files = entries.filter((name) => !directories.includes(name));
    if (directories.length) parts.push(`Top-level directories: ${directories.join(", ")}`);
    if (files.length) parts.push(`Top-level files: ${files.join(", ")}`);
  } catch { /* Best effort only. */ }
  return parts.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
