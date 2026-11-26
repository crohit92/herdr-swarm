// Herdr action: build-herdr-dev-mod
//
// Builds the herdr-dev mod and installs it in the user-level Claude folder:
//   1. validates the mod with `claude plugin validate`,
//   2. runs the mod's tests,
//   3. copies mods/herdr-dev to ~/.claude/dev-mods/herdr-dev.
// The copy replaces the previous build in that folder. Claude hot-loads function-hook
// mods from dev-mods; a skills-folder plugin loads but its hooks module does not.

import { existsSync } from "node:fs";
import { copyFile, cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const source = join(repoRoot, "mods", "herdr-dev");
const target = join(homedir(), ".claude", "dev-mods", "herdr-dev");

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function run(argv: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exitCode: await p.exited, output: stdout + stderr };
}

// Adds the folder to CLAUDE_CODE_PLUGIN_DIRS in the user's settings, keeping other entries
// and settings. Saves a backup before writing, and writes only when something changed.
async function registerPluginDir(dir: string): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
  settings.env = settings.env ?? {};
  const entries: string[] = (settings.env.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(delimiter).filter(Boolean);
  if (entries.includes(dir)) {
    console.log("already registered");
    return;
  }
  if (existsSync(settingsPath)) await copyFile(settingsPath, `${settingsPath}.bak`);
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = [...entries, dir].join(delimiter);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`added ${dir}`);
}

async function main(): Promise<void> {
  if (!(await stat(source).then((s) => s.isDirectory()).catch(() => false))) {
    fail(`${source} not found. Run this from the herdr-swarm repository.`);
  }

  console.log("==> Validating the mod");
  const validate = await run(["claude", "plugin", "validate", source], repoRoot);
  console.log(validate.output.trim());
  if (validate.exitCode !== 0 || /Validation failed/.test(validate.output)) fail("validation failed; the mod was not installed");

  console.log("\n==> Running the mod's tests");
  const tests = await run(["bun", "test", "src/tick.test.ts"], source);
  console.log(tests.output.trim().split("\n").slice(-4).join("\n"));
  if (tests.exitCode !== 0) fail("tests failed; the mod was not installed");

  console.log(`\n==> Installing to ${target}`);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  console.log("installed");

  console.log("\n==> Registering the folder in ~/.claude/settings.json");
  await registerPluginDir(target);
  console.log("registered. Start a new Claude session, then run /herdr-dev status.");
}

await main();
