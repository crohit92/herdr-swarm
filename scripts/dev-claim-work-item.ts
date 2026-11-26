// Herdr action: dev-claim-work-item
//
// Claims one work item for the mod. The mod has already written the flag with
// status "claiming". This action:
//   1. checks the item is still To Do in Azure,
//   2. sets it to Doing,
//   3. creates the worktree and branch from a fresh origin/<base> (or reuses them),
//   4. moves the flag to "doing".
// On any failure it puts Azure back to To Do where it changed it, archives the
// claiming flag with the reason, and exits 1.

import {
  DevError,
  archiveFlag,
  azure,
  branchName,
  fail,
  loadActiveProject,
  paths,
  readFlag,
  readJson,
  report,
  run,
  stateDir,
  takeRequest,
  worktreePath,
  writeJson,
} from "./dev-lib";
import type { Flag, WorkItem, WorkItems } from "./dev-lib";

const dir = stateDir();

async function main(): Promise<void> {
  const project = await loadActiveProject(dir);
  const { workItemId } = await takeRequest<{ workItemId: number }>(dir, "claim");
  const flag = await readFlag(dir, workItemId);
  if (!flag || flag.status !== "claiming") {
    throw new DevError(`flag for work item ${workItemId} is not in claiming state`);
  }

  const items = await readItems(dir);
  const item = items.find((i) => i.id === workItemId);
  if (!item) throw new DevError(`work item ${workItemId} is not in the fetched list`);

  let setDoing = false;
  try {
    const state = await azure.state(workItemId);
    if (state !== "To Do") {
      throw new DevError(`work item ${workItemId} is "${state}" in Azure, not "To Do"`);
    }
    await azure.setState(workItemId, "Doing");
    setDoing = true;

    const branch = flag.branch ?? branchName(workItemId, item.title);
    const worktree = flag.worktree ?? worktreePath(project.repoRoot, workItemId);
    await ensureWorktree(project.repoRoot, project.baseBranch, branch, worktree);

    const next: Flag = {
      ...flag,
      status: "doing",
      branch,
      worktree,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(paths.flag(dir, workItemId), next);
    report({ ok: true, workItemId, branch, worktree });
  } catch (err) {
    if (setDoing) await azure.setState(workItemId, "To Do").catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    await archiveFlag(dir, workItemId, `claim failed: ${reason}`);
    throw err;
  }
}

// Creates the worktree on a new branch from the fresh base, or reuses it when this is
// a resumed attempt. Never force-moves a branch that already has commits.
async function ensureWorktree(repoRoot: string, base: string, branch: string, worktree: string): Promise<void> {
  const fetch = await run(["git", "fetch", "origin", base], repoRoot);
  if (fetch.exitCode !== 0) throw new DevError(`git fetch origin ${base} failed: ${fetch.stderr.trim()}`);

  const existing = await run(["git", "worktree", "list", "--porcelain"], repoRoot);
  if (existing.stdout.includes(`worktree ${worktree}\n`)) return;

  const branchExists = (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)).exitCode === 0;
  const add = branchExists
    ? await run(["git", "worktree", "add", worktree, branch], repoRoot)
    : await run(["git", "worktree", "add", "-b", branch, worktree, `origin/${base}`], repoRoot);
  if (add.exitCode !== 0) throw new DevError(`git worktree add failed: ${add.stderr.trim()}`);
}

async function readItems(stateDirPath: string): Promise<WorkItem[]> {
  const data = await readJson<WorkItems>(paths.workItems(stateDirPath));
  if (!data) throw new DevError("no work-items.json. Run dev-fetch-work-items first.");
  return data.items;
}

try {
  await main();
} catch (err) {
  fail(err instanceof DevError ? err.message : String(err));
}
