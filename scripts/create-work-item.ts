// Creates an Azure Boards work item, assigned to the signed-in user by default.
//
// Usage:
//   bun plugin/scripts/create-work-item.ts --title "Fix login" [options]
//
// Options:
//   --title <text>         Required. Work item title.
//   --type <name>          Work item type (default: Task), e.g. Bug, User Story.
//   --description <text>   Plain-text description.
//   --tags <list>          Tags separated by commas or semicolons, e.g. "backend, urgent".
//   --assign-to <name>     Assignee (name or email). Default: the signed-in az user.
//   --dry-run              Print the az command without creating anything.
//
// Environment fallbacks, used when the flag is not given (lets the herdr action pass input):
//   WORK_ITEM_TITLE, WORK_ITEM_TYPE, WORK_ITEM_DESCRIPTION, WORK_ITEM_TAGS, WORK_ITEM_ASSIGN_TO
//
// Uses the organization and project defaults set by `az devops configure`.
// Requires `az login` and the azure-devops extension.

import { $ } from "bun";

const die = (msg: string): never => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

// Parses --flag value pairs and boolean --flags.
function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) die(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "dry-run") {
      flags.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) die(`--${name} needs a value`);
    flags.set(name, value);
    i++;
  }
  return flags;
}

const known = new Set(["title", "type", "description", "tags", "assign-to", "dry-run"]);
const flags = parseArgs(process.argv.slice(2));
for (const name of flags.keys()) {
  if (!known.has(name)) die(`unknown option --${name}`);
}

const pick = (flag: string, env: string): string | undefined => {
  const value = flags.get(flag);
  if (typeof value === "string") return value;
  return process.env[env] || undefined;
};

const title = pick("title", "WORK_ITEM_TITLE")?.trim();
if (!title) die("a title is required. Pass --title or set WORK_ITEM_TITLE.");

const type = pick("type", "WORK_ITEM_TYPE")?.trim() || "Task";
const description = pick("description", "WORK_ITEM_DESCRIPTION")?.trim() || "";
const tags = (pick("tags", "WORK_ITEM_TAGS") ?? "")
  .split(/[;,]/)
  .map((t) => t.trim())
  .filter((t) => t !== "");
const dryRun = flags.get("dry-run") === true;

if (!Bun.which("az")) die("Azure CLI (az) not found. Install the required tools and re-run.");

let assignee = pick("assign-to", "WORK_ITEM_ASSIGN_TO")?.trim();
if (!assignee) {
  const me = await $`az account show --query user.name -o tsv`.quiet().nothrow();
  if (me.exitCode !== 0) die("could not determine the signed-in user. Run: az login");
  assignee = me.stdout.toString().trim();
}

// Azure stores tags as one semicolon-separated field.
const fields: string[] = [];
if (tags.length > 0) fields.push(`System.Tags=${tags.join("; ")}`);

const summary = [
  `title:       ${title}`,
  `type:        ${type}`,
  `assigned to: ${assignee}`,
  `tags:        ${tags.length > 0 ? tags.join(", ") : "(none)"}`,
  `description: ${description ? "yes" : "(none)"}`,
];

if (dryRun) {
  console.log("Dry run. Would create:");
  console.log(summary.map((l) => `  ${l}`).join("\n"));
  process.exit(0);
}

// Build the arguments as an array so each value reaches az as a single argument.
const cmd = [
  "az", "boards", "work-item", "create",
  "--title", title,
  "--type", type,
  "--assigned-to", assignee,
  "-o", "json",
];
if (description) cmd.push("--description", description);
if (fields.length > 0) cmd.push("--fields", ...fields);

const result = await $`${cmd}`.quiet().nothrow();
if (result.exitCode !== 0) {
  die(`az boards work-item create failed:\n${result.stderr.toString().trim()}`);
}

const created = JSON.parse(result.stdout.toString());
console.log(`Created work item #${created.id}: ${created.fields?.["System.Title"] ?? title}`);
console.log(summary.map((l) => `  ${l}`).join("\n"));
console.log(`  url:         ${created.url ?? ""}`);
