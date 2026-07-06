/**
 * `termyte share` — export a portable context file for cross-agent use.
 *
 * The command writes the current Termyte context to a repo-local
 * markdown file by default, so Claude, Codex, or any other agent can
 * consume the same project knowledge.
 */
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";
import { join } from "node:path";
import { contextCommand } from "./context.js";

export async function shareCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
  type?: string;
  path?: string;
  json?: boolean;
  silent?: boolean;
} = {}): Promise<void> {
  const workspaceRoot = detectWorkspaceRoot(process.cwd());
  const path = options.path ?? join(workspaceRoot, ".termyte", "share", "context.md");
  await contextCommand({
    repo_id: options.repo_id ?? detectRepoId(workspaceRoot),
    query: options.query,
    limit: options.limit,
    currentFiles: options.currentFiles,
    type: options.type,
    writeFile: path,
    json: options.json && !options.silent,
    silent: options.silent,
  });
  if (!options.silent && !options.json) {
    process.stderr.write(`termyte: shared context written to ${path}\n`);
  }
  if (!options.silent && options.json) {
    process.stdout.write(JSON.stringify({ sharedContextPath: path }, null, 2) + "\n");
  }
  return;
}
