// Lists Azure Boards work items assigned to the signed-in user.
//
// Usage:
//   bun run plugin/scripts/list-my-work-items.ts [--all] [--json]
//
//   --all   include closed/done/removed items (default: open items only)
//   --json  print the raw work items as JSON instead of a table
//
// Uses the organization and project defaults set by `az devops configure`
// (see the configure-azure action). Requires `az login` and the azure-devops extension.

import { $ } from "bun";

const args = new Set(process.argv.slice(2));
const includeAll = args.has("--all");
const asJson = args.has("--json");

const die = (msg: string): never => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};

const unknown = [...args].filter((a) => a !== "--all" && a !== "--json");
if (unknown.length > 0) die(`unknown option(s): ${unknown.join(", ")}. Use --all and/or --json.`);

if (!Bun.which("az")) die("Azure CLI (az) not found. Install the required tools and re-run.");

// States that mean "finished" across the Agile, Scrum and CMMI process templates.
const closedStates = ["Closed", "Done", "Removed"];
const stateFilter = includeAll
  ? ""
  : ` AND [System.State] NOT IN (${closedStates.map((s) => `'${s}'`).join(", ")})`;

// The project the az defaults point at. Items are limited to it so the list
// doesn't mix in work from other projects in the organization.
async function defaultProject(): Promise<string> {
  const config = await $`az devops configure -l`.quiet().nothrow();
  const match = config.stdout.toString().match(/^\s*project\s*=\s*(.+)$/m);
  const project = match?.[1]?.trim();
  if (!project) die("no default project is set. Run: az devops configure -d project=NAME");
  return project;
}

const project = await defaultProject();
// Escape single quotes for the WIQL string literal.
const projectLiteral = `'${project.replace(/'/g, "''")}'`;

const wiql =
  "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.Description], [System.Tags] " +
  "FROM WorkItems " +
  `WHERE [System.AssignedTo] = @Me AND [System.TeamProject] = ${projectLiteral}${stateFilter} ` +
  "ORDER BY [System.ChangedDate] DESC";

const result = await $`az boards query --wiql ${wiql} --project ${project} -o json`.quiet().nothrow();
if (result.exitCode !== 0) {
  die(`az boards query failed:\n${result.stderr.toString().trim()}`);
}

type WorkItem = {
  id: number;
  url: string;
  fields: Record<string, string | number | undefined>;
};

const items: WorkItem[] = JSON.parse(result.stdout.toString() || "[]");

if (asJson) {
  console.log(JSON.stringify(items, null, 2));
  process.exit(0);
}

if (items.length === 0) {
  console.log(includeAll ? "No work items are assigned to you." : "No open work items are assigned to you.");
  process.exit(0);
}

// Azure DevOps stores descriptions as HTML. Turn it into readable plain text.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

const rows = items.map((item) => ({
  id: String(item.id),
  type: String(item.fields["System.WorkItemType"] ?? ""),
  state: String(item.fields["System.State"] ?? ""),
  title: String(item.fields["System.Title"] ?? ""),
  description: htmlToText(String(item.fields["System.Description"] ?? "")),
  // Azure stores tags as one string separated by semicolons, e.g. "backend; urgent".
  tags: String(item.fields["System.Tags"] ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t !== ""),
}));

const width = (key: keyof (typeof rows)[number], header: string) =>
  Math.max(header.length, ...rows.map((r) => r[key].length));

const cols = {
  id: width("id", "ID"),
  type: width("type", "TYPE"),
  state: width("state", "STATE"),
};

const line = (id: string, type: string, state: string, title: string) =>
  `${id.padEnd(cols.id)}  ${type.padEnd(cols.type)}  ${state.padEnd(cols.state)}  ${title}`;

console.log(line("ID", "TYPE", "STATE", "TITLE"));
for (const r of rows) console.log(line(r.id, r.type, r.state, r.title));

const withDetails = rows.filter((r) => r.description !== "" || r.tags.length > 0);
for (const r of withDetails) {
  console.log(`\n#${r.id} ${r.title}`);
  if (r.tags.length > 0) console.log(`Tags: ${r.tags.join(", ")}`);
  if (r.description !== "") {
    console.log("");
    console.log(r.description.split("\n").map((l) => `    ${l}`).join("\n"));
  }
}

console.log(`\n${rows.length} item(s)`);
