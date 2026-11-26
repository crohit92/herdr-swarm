// Herdr action: build-herdr-dev-mod
//
// Builds the herdr-dev mod and installs it in the user-level Claude folder:
//   1. validates the mod with `claude plugin validate`,
//   2. runs the mod's tests,
//   3. copies mods/herdr-dev to ~/.claude/plugins/herdr-dev.
// The copy replaces the previous build in that folder. The folder is only loaded
// once the plugin is registered with Claude; the output says whether it is.

import { cp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const source = join(repoRoot, "mods", "herdr-dev");
const target = join(homedir(), ".claude", "plugins", "herdr-dev");

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function run(argv: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { exitCode: await p.exited, output: stdout + stderr };
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

  console.log(
    "\nNote: Claude loads this folder only once the plugin is registered. " +
      "See `claude plugin --help` for how to register it.",
  );
}

await main();
