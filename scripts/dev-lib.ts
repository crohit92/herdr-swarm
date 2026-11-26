// Shared code for the herdr-dev actions and the mod.
//
// The mod and the actions share one state directory. Actions write the work
// item list and the flags; the mod reads them and decides what runs next.
// See docs/herdr-dev-design.html for the full design.

import { $ } from "bun";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PLUGIN_ID = "dev.automation";

export type FlagStatus = "claiming" | "doing" | "finishing" | "done";

export type Flag = {
  workItemId: number;
  status: FlagStatus;
  attempt: number;
  branch?: string;
  worktree?: string;
  agentName?: string;
  prUrl?: string;
  startedAt: string;
  updatedAt: string;
};

export type WorkItem = {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  tags: string[];
  description: string;
};

export type WorkItems = {
  fetchedAt: string;
  project: string;
  items: WorkItem[];
};

export type ActiveProject = {
  repoRoot: string;
  azureProject: string;
  intervalSeconds: number;
  baseBranch: string;
  maxAttempts: number;
  stateDir: string;
  startedAt: string;
};

export class DevError extends Error {}

// The state directory. Herdr sets HERDR_PLUGIN_STATE_DIR for actions. An explicit
// HERDR_DEV_STATE_DIR (from the target project's .env, read by the mod) wins.
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.HERDR_DEV_STATE_DIR) return env.HERDR_DEV_STATE_DIR;
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  const xdg = env.XDG_STATE_HOME || join(homedir(), ".local/state");
  return join(xdg, "herdr/plugins", PLUGIN_ID);
}

export const paths = {
  activeProject: (dir: string) => join(dir, "active-project.json"),
  workItems: (dir: string) => join(dir, "work-items.json"),
  flag: (dir: string, id: number) => join(dir, "flags", `wi-${id}.json`),
  flagsDir: (dir: string) => join(dir, "flags"),
  archiveDir: (dir: string) => join(dir, "archive"),
  requestsDir: (dir: string) => join(dir, "requests"),
  request: (dir: string, action: string) => join(dir, "requests", `${action}.json`),
  result: (dir: string, id: number) => join(dir, "results", `wi-${id}.json`),
};

// Reads JSON. Returns undefined when the file is missing; throws DevError when it is unreadable.
export async function readJson<T>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as T;
  } catch {
    throw new DevError(`unreadable file: ${path}`);
  }
}

// Writes JSON through a temporary file, so a reader never sees half a file.
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

// Reads the flag for a work item and fails loudly if the file is corrupt.
export async function readFlag(dir: string, id: number): Promise<Flag | undefined> {
  return readJson<Flag>(paths.flag(dir, id));
}

// How many flags were ended for an item. Each archived flag is one attempt.
export async function attemptsSoFar(dir: string, id: number): Promise<number> {
  const names = await listJsonFiles(paths.archiveDir(dir));
  return names.filter((n) => n.startsWith(`wi-${id}-`)).length;
}

// Moves a flag into archive/ with a reason. The reason is kept for the user to read.
export async function archiveFlag(dir: string, id: number, reason: string): Promise<void> {
  const flag = await readFlag(dir, id);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(join(paths.archiveDir(dir), `wi-${id}-${ts}.json`), {
    reason,
    previousFlag: flag ?? null,
    archivedAt: new Date().toISOString(),
  });
  await removeFile(paths.flag(dir, id));
}

// Reads the request file an action was given, then deletes it.
export async function takeRequest<T>(dir: string, action: string): Promise<T> {
  const request = await readJson<T>(paths.request(dir, action));
  if (request === undefined) throw new DevError(`no request file for ${action}`);
  await removeFile(paths.request(dir, action));
  return request;
}

// .env parser: KEY=VALUE per line, comments and blank lines skipped, optional quotes removed.
export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
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

// Settings the mod needs from the target project's .env, with their rules.
export function readProjectSettings(env: Record<string, string>): Omit<ActiveProject, "repoRoot" | "stateDir" | "startedAt"> {
  const errors: string[] = [];
  const interval = Number(env.HERDR_DEV_INTERVAL_SECONDS);
  if (!env.HERDR_DEV_INTERVAL_SECONDS) errors.push("HERDR_DEV_INTERVAL_SECONDS is required");
  else if (!Number.isInteger(interval) || interval < 30) errors.push("HERDR_DEV_INTERVAL_SECONDS must be an integer of at least 30");

  const maxAttempts = env.HERDR_DEV_MAX_ATTEMPTS ? Number(env.HERDR_DEV_MAX_ATTEMPTS) : 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) errors.push("HERDR_DEV_MAX_ATTEMPTS must be a positive integer");

  if (!env.AZURE_DEVOPS_ORG) errors.push("AZURE_DEVOPS_ORG is required");
  if (!env.AZURE_DEVOPS_PROJECT) errors.push("AZURE_DEVOPS_PROJECT is required");

  if (errors.length > 0) throw new DevError(errors.join("; "));
  return {
    intervalSeconds: interval,
    baseBranch: env.HERDR_DEV_BASE_BRANCH || "main",
    maxAttempts,
  };
}

export async function loadActiveProject(dir: string): Promise<ActiveProject> {
  const project = await readJson<ActiveProject>(paths.activeProject(dir));
  if (!project) throw new DevError("no active project. Run /herdr-dev start first.");
  return project;
}

// Branch and worktree names for an item. The slug keeps branch names readable and safe.
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "work";
}

export function branchName(id: number, title: string): string {
  return `feature/wi-${id}-${slugify(title)}`;
}

export function worktreePath(repoRoot: string, id: number): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`, `wi-${id}`);
}

// Azure WIQL for the mod's queue: my items in this project, in the three states.
export function queueWiql(project: string): string {
  const literal = `'${project.replace(/'/g, "''")}'`;
  return (
    "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], " +
    "[System.Description], [System.Tags], [Microsoft.VSTS.Common.Priority] " +
    "FROM WorkItems " +
    `WHERE [System.AssignedTo] = @Me AND [System.TeamProject] = ${literal} ` +
    "AND [System.State] IN ('To Do', 'Doing', 'Done') " +
    "ORDER BY [System.ChangedDate] DESC"
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// Runs a command with no shell and returns its output. Never throws on a non-zero exit.
export async function run(argv: string[], cwd?: string) {
  const result = cwd
    ? await $`${argv}`.cwd(cwd).quiet().nothrow()
    : await $`${argv}`.quiet().nothrow();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// Azure CLI helpers. Each one is a single call, so the caller decides what a failure means.
export const azure = {
  async state(id: number): Promise<string> {
    const r = await run(["az", "boards", "work-item", "show", "--id", String(id), "--query", 'fields."System.State"', "-o", "tsv"]);
    if (r.exitCode !== 0) throw new DevError(`az could not read work item ${id}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  },
  async setState(id: number, state: "To Do" | "Doing" | "Done"): Promise<void> {
    const r = await run(["az", "boards", "work-item", "update", "--id", String(id), "--state", state, "-o", "none"]);
    if (r.exitCode !== 0) throw new DevError(`az could not set work item ${id} to ${state}: ${r.stderr.trim()}`);
  },
  async query(project: string): Promise<WorkItem[]> {
    const r = await run(["az", "boards", "query", "--wiql", queueWiql(project), "--project", project, "-o", "json"]);
    if (r.exitCode !== 0) throw new DevError(`az boards query failed: ${r.stderr.trim()}`);
    const rows = JSON.parse(r.stdout || "[]") as Array<{ id: number; fields: Record<string, unknown> }>;
    return rows.map((row) => ({
      id: row.id,
      title: String(row.fields["System.Title"] ?? ""),
      type: String(row.fields["System.WorkItemType"] ?? ""),
      state: String(row.fields["System.State"] ?? ""),
      priority: typeof row.fields["Microsoft.VSTS.Common.Priority"] === "number" ? (row.fields["Microsoft.VSTS.Common.Priority"] as number) : undefined,
      tags: String(row.fields["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
      description: htmlToText(String(row.fields["System.Description"] ?? "")),
    }));
  },
};

// Writes a line of output for the mod to read from the plugin log.
export function report(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

export function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

