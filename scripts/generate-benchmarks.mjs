import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outPath = path.join(root, "benchmarks", "commands.json");

const cases = [];

function add(category, expectedDecisions, commands) {
  for (const command of commands) {
    cases.push({ command, category, expectedDecisions });
  }
}

add("filesystem-delete-single", ["allow"], [
  "rm extrafile",
  "rm notes.txt",
  "rm report.md",
  "rm draft.txt",
  "rm temp.log",
  "rm cache.json",
  "rm scratch.tmp",
  "rm old.txt",
  "rm archive.zip",
  "rm session.json",
]);

add("filesystem-delete-config", ["warn"], [
  "rm .env",
  "rm .env.local",
  "rm .env.production",
  "rm .npmrc",
  "rm package.json",
  "rm package-lock.json",
  "rm pnpm-lock.yaml",
  "rm yarn.lock",
  "rm tsconfig.json",
  "rm vite.config.ts",
]);

add("filesystem-delete-source", ["warn"], [
  "rm src",
  "rm app",
  "rm lib",
  "rm src/index.ts",
  "rm src/utils.ts",
  "rm app/main.ts",
  "rm lib/index.js",
  "rm src/components",
  "rm app/routes",
  "rm lib/helpers",
]);

add("filesystem-delete-build", ["warn"], [
  "rm dist",
  "rm build",
  "rm dist/assets",
  "rm build/output",
  "rm dist/server",
  "rm build/tmp",
  "rm dist/chunks",
  "rm build/reports",
  "rm dist/static",
  "rm build/cache",
]);

add("filesystem-delete-git-metadata", ["block"], [
  "rm .git",
  "rm -rf .git",
  "rm .github",
  "rm -rf .github",
  "Remove-Item -Recurse -Force .git",
  "Remove-Item -Recurse -Force .github",
  "rm -rf .git/hooks",
  "rm -rf .git/refs",
  "rm -rf .git/objects",
  "rm -rf .git/logs",
]);

add("filesystem-delete-home", ["block"], [
  "rm ~/notes.txt",
  "rm ~/Downloads/file.txt",
  "rm ~/Desktop/temp.txt",
  "rm ~/Documents/todo.md",
  "Remove-Item -Recurse -Force ~/Desktop/temp.txt",
  "Remove-Item -Recurse -Force ~/Downloads/file.txt",
  "rm ~/",
  "rm ~/Projects/sample.txt",
  "Remove-Item -Recurse -Force ~/Documents/todo.md",
  "rm ~/Library/cache.db",
]);

add("filesystem-delete-root", ["block"], [
  "rm /",
  "rm -rf /",
  "Remove-Item -Recurse -Force C:/",
  "rm C:/",
  "rm -rf C:/",
  "Remove-Item -Recurse -Force C:/Windows",
  "rm /Windows",
  "rm -rf /Windows",
  "Remove-Item -Recurse -Force /",
  "rm -rf C:/Windows/System32",
]);

add("filesystem-delete-wildcard", ["block"], [
  "rm -rf *",
  "rm -rf src/*",
  "rm -rf **",
  "rm -rf ?*",
  "rm -rf [a-z]*",
  "del /s /q *",
  "Remove-Item -Recurse -Force *",
  "Remove-Item -Recurse -Force src/*",
  "rm -rf ./dist/*",
  "rm -rf ./build/*",
]);

add("filesystem-delete-deps", ["warn", "allow"], [
  "rm -rf node_modules",
  "Remove-Item -Recurse -Force node_modules",
  "rm -rf ./node_modules",
  "Remove-Item -Recurse -Force ./node_modules",
  "rm -rf node_modules/",
  "Remove-Item -Recurse -Force node_modules/",
  "rm node_modules",
  "Remove-Item -Recurse -Force ./node_modules/",
  "rm -rf node_modules/cache",
  "Remove-Item -Recurse -Force node_modules/cache",
]);

add("filesystem-delete-powershell", ["block"], [
  "Remove-Item -Recurse -Force *",
  "Remove-Item -Recurse -Force src/*",
  "Remove-Item -Recurse -Force .git",
  "Remove-Item -Recurse -Force .github",
  "Remove-Item -Recurse -Force C:/",
  "Remove-Item -Recurse -Force ~/Desktop/temp.txt",
  "Remove-Item -Recurse -Force node_modules/*",
  "Remove-Item -Recurse -Force dist/*",
  "Remove-Item -Recurse -Force build/*",
  "Remove-Item -Recurse -Force app/*",
]);

add("git-force-push-feature", ["warn"], [
  "git push --force origin feature",
  "git push --force origin feature-1",
  "git push --force origin bugfix/work",
  "git push --force origin chore/demo",
  "git push --force origin release/demo",
  "git push --force-with-lease origin feature",
  "git push -f origin feature",
  "git push --force upstream feature",
  "git push --force origin hotfix",
  "git push --force origin spike",
]);

add("git-force-push-protected", ["block"], [
  "git push --force origin main",
  "git push --force origin master",
  "git push --force origin trunk",
  "git push -f origin main",
  "git push --force-with-lease origin main",
  "git push --force origin master",
  "git push --force origin trunk",
  "git push --force upstream main",
  "git push --force upstream master",
  "git push --force upstream trunk",
]);

add("package-publish", ["warn"], [
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "npm publish --access public",
  "pnpm publish --access public",
  "yarn npm publish",
  "npm publish --tag next",
  "pnpm publish --tag next",
  "yarn publish --tag beta",
  "npm publish --dry-run",
]);

add("sql-delete-no-where", ["block"], [
  "DELETE FROM users",
  "DELETE FROM sessions",
  "DELETE FROM audit_logs",
  "DELETE FROM orders",
  "DELETE FROM events",
  "DELETE FROM messages",
  "DELETE FROM tokens",
  "DELETE FROM tasks",
  "DELETE FROM comments",
  "DELETE FROM invoices",
]);

add("sql-delete-with-where", ["warn"], [
  "DELETE FROM users WHERE id = 1",
  "DELETE FROM sessions WHERE expired = 1",
  "DELETE FROM audit_logs WHERE created_at < NOW()",
  "DELETE FROM orders WHERE status = 'cancelled'",
  "DELETE FROM events WHERE archived = 1",
  "DELETE FROM messages WHERE read = 1",
  "DELETE FROM tokens WHERE revoked = 1",
  "DELETE FROM tasks WHERE done = 1",
  "DELETE FROM comments WHERE flagged = 1",
  "DELETE FROM invoices WHERE paid = 1",
]);

add("sql-drop", ["block"], [
  "DROP TABLE users",
  "DROP TABLE sessions",
  "DROP TABLE audit_logs",
  "DROP TABLE orders",
  "DROP TABLE events",
  "DROP TABLE messages",
  "DROP TABLE tokens",
  "DROP TABLE tasks",
  "DROP TABLE comments",
  "DROP TABLE invoices",
]);

add("sql-truncate", ["block"], [
  "TRUNCATE TABLE users",
  "TRUNCATE TABLE sessions",
  "TRUNCATE TABLE audit_logs",
  "TRUNCATE TABLE orders",
  "TRUNCATE TABLE events",
  "TRUNCATE TABLE messages",
  "TRUNCATE TABLE tokens",
  "TRUNCATE TABLE tasks",
  "TRUNCATE TABLE comments",
  "TRUNCATE TABLE invoices",
]);

add("shell-generic", ["allow"], [
  "echo hello",
  "pwd",
  "dir",
  "node -e \"console.log(1)\"",
  "node -e \"console.log('demo')\"",
  "python -c \"print('x')\"",
  "git status",
  "npm test",
  "echo safe",
  "node -e \"console.log('safe')\"",
]);

if (cases.length !== 180) {
  throw new Error(`Expected 180 cases, got ${cases.length}`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");
console.log(`Wrote ${cases.length} benchmark cases to ${outPath}`);
