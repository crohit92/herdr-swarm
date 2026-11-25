// Herdr action: configure-azure
//
// Reads AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT from the `.env` at the git root of the
// workspace that invoked the action, then sets them as the Azure DevOps CLI defaults:
//   az devops configure --defaults organization=<org> project=<project>
//
// Repo resolution (never trusts the action's cwd alone):
//   1. HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd, set by herdr for the invoking workspace
//   2. process.cwd(), only when that context is absent or unparseable
//   then `git rev-parse --show-toplevel` from that directory.
//
// Variables already set in the environment take precedence over the .env file.

import { $ } from "bun";
import { join } from "node:path";

// Returns the git toplevel for the invoking workspace, or exits with a message.
async function resolveRepoRoot(): Promise<string> {
  let dir = "";
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      const ctx = JSON.parse(raw);
      if (typeof ctx.workspace_cwd === "string") dir = ctx.workspace_cwd;
    } catch {
      // Unparseable context: fall back to cwd below.
    }
  }
  if (!dir) dir = process.cwd();

  const result = await $`git -C ${dir} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    console.error(`ERROR: ${dir} is not inside a git repository. Run this action from a repo workspace.`);
    process.exit(1);
  }
  return result.stdout.toString().trim();
}

// Minimal KEY=VALUE parser. Skips blank lines and comments; strips optional quotes.
async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const raw of (await Bun.file(path).text()).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    vars[key] = value;
  }
  return vars;
}

const repoRoot = await resolveRepoRoot();
const envFile = join(repoRoot, ".env");

if (!(await Bun.file(envFile).exists())) {
  console.error(`ERROR: ${envFile} not found. Create it with AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT.`);
  process.exit(1);
}

const fileVars = await loadEnvFile(envFile);
const env: Record<string, string | undefined> = { ...fileVars, ...process.env };

const org = env.AZURE_DEVOPS_ORG?.trim();
const project = env.AZURE_DEVOPS_PROJECT?.trim();

const missing = [
  !org && "AZURE_DEVOPS_ORG",
  !project && "AZURE_DEVOPS_PROJECT",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`ERROR: missing ${missing.join(", ")} in ${envFile}.`);
  process.exit(1);
}

if (!Bun.which("az")) {
  console.error("ERROR: Azure CLI (az) not found. Run the setup-tools action first.");
  process.exit(1);
}

console.log(`Repo root: ${repoRoot}`);
console.log(`Env file:  ${envFile}`);
console.log("Setting Azure DevOps defaults:");
console.log(`  organization = ${org}`);
console.log(`  project      = ${project}`);

// Bun's shell escapes interpolated values.
await $`az devops configure --defaults organization=${org} project=${project}`;

console.log("\nCurrent defaults:");
await $`az devops configure -l`;
