// Herdr action: setup-tools
//
// Verifies that the CLI tools needed for the herdr-swarm Azure/GitHub workflow are installed:
//   1. Azure CLI (az)
//   2. Azure DevOps extension for az (azure-devops)
//   3. GitHub CLI (gh)
// Nothing is installed here. If a tool is missing, the script exits with an error
// listing what needs to be installed.
// Bun is assumed present, since this script runs under it.
// Azure DevOps defaults are set by the separate configure-azure action.
// Login status is informational only; this script does not log in.

import { $ } from "bun";

const log = (msg: string) => console.log(`\n==> ${msg}`);
const warn = (msg: string) => console.error(`WARNING: ${msg}`);
const die = (msg: string): never => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

// Returns the first line of a string, or "" when there is none.
const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? "";

// Runs a command and returns trimmed stdout, or null if it exits non-zero.
async function tryOutput(run: () => Promise<{ exitCode: number; stdout: Buffer }>): Promise<string | null> {
  const result = await run();
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

const azVersion = () =>
  tryOutput(() => $`az version --query ${'"azure-cli"'} -o tsv`.quiet().nothrow());

const azDevopsVersion = () =>
  tryOutput(() => $`az extension show --name azure-devops --query version -o tsv`.quiet().nothrow());

async function azDevopsInstalled(): Promise<boolean> {
  const out = await tryOutput(() =>
    $`az extension list --query ${"[?name=='azure-devops'].name"} -o tsv`.quiet().nothrow(),
  );
  return out !== null && out.split(/\r?\n/).some((line) => line.trim() === "azure-devops");
}

async function ghVersion(): Promise<string> {
  return firstLine((await $`gh --version`.quiet()).stdout.toString());
}

async function main() {
  const missing: string[] = [];

  // 1. Azure CLI
  log("Checking Azure CLI (az)");
  const hasAz = Bun.which("az") !== null;
  if (hasAz) {
    console.log(`az found: ${(await azVersion()) ?? "version unknown"}`);
  } else {
    console.log("az not found.");
    missing.push("Azure CLI (az): brew install azure-cli");
  }

  // 2. Azure DevOps extension (provides `az boards ...`, `az repos ...`, etc.)
  log("Checking Azure DevOps extension (azure-devops)");
  if (!hasAz) {
    console.log("Skipped: requires az.");
    missing.push("Azure DevOps extension: az extension add --name azure-devops --yes");
  } else if (await azDevopsInstalled()) {
    console.log(`azure-devops extension found: ${await azDevopsVersion()}`);
  } else {
    console.log("azure-devops extension not found.");
    missing.push("Azure DevOps extension: az extension add --name azure-devops --yes");
  }

  // 3. GitHub CLI (gh)
  log("Checking GitHub CLI (gh)");
  if (Bun.which("gh")) {
    console.log(`gh found: ${await ghVersion()}`);
  } else {
    console.log("gh not found.");
    missing.push("GitHub CLI (gh): brew install gh");
  }

  if (missing.length > 0) {
    die(
      `missing required tools. Install them and re-run this action:\n  - ${[...new Set(missing)].join("\n  - ")}`,
    );
  }

  log("Done. Tool status:");
  console.log(`  az:           ${(await azVersion()) ?? ""}`);
  console.log(`  azure-devops: ${(await azDevopsVersion()) ?? ""}`);
  console.log(`  gh:           ${await ghVersion()}`);

  const azLoggedIn = (await $`az account show`.quiet().nothrow()).exitCode === 0;
  if (!azLoggedIn) warn("Azure CLI is not logged in. Run: az login");

  const ghLoggedIn = (await $`gh auth status`.quiet().nothrow()).exitCode === 0;
  if (!ghLoggedIn) warn("GitHub CLI is not logged in. Run: gh auth login");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
