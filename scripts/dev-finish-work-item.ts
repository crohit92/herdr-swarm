// Herdr action: dev-finish-work-item
//
// Finishes one work item after its agent reported success. The mod has already
// moved the flag to "finishing". This action:
//   1. checks the agent's result file says "success",
//   2. checks the worktree has no uncommitted changes,
//   3. pushes the feature branch to origin (never forced, never to the base branch),
//   4. finds the open pull request for the branch, or creates it into the base branch,
//   5. sets the work item to Done,
//   6. moves the flag to "done" with the pull request URL.
// Each step checks before it acts, so a retry after a failure is safe.
// On failure the flag stays "finishing" and the action exits 1.

import {
  DevError,
  azure,
  fail,
  loadActiveProject,
  paths,
  readFlag,
  readJson,
  report,
  run,
  stateDir,
  takeRequest,
  writeJson,
} from "./dev-lib";
import type { Flag, WorkItem, WorkItems } from "./dev-lib";

type AgentResult = { status: "success" | "failed"; summary?: string; commit?: string };

const dir = stateDir();

async function main(): Promise<void> {
  const project = await loadActiveProject(dir);
  const { workItemId } = await takeRequest<{ workItemId: number }>(dir, "finish");
  const flag = await readFlag(dir, workItemId);
  if (!flag || flag.status !== "finishing") {
    throw new DevError(`flag for work item ${workItemId} is not in finishing state`);
  }
  if (!flag.branch || !flag.worktree) throw new DevError(`flag for work item ${workItemId} has no branch or worktree`);

  const result = await readJson<AgentResult>(paths.result(dir, workItemId));
  if (!result) throw new DevError(`no result file for work item ${workItemId}`);
  if (result.status !== "success") throw new DevError(`agent reported "${result.status}", not success`);

  const status = await run(["git", "status", "--porcelain"], flag.worktree);
  if (status.exitCode !== 0) throw new DevError(`git status failed in ${flag.worktree}: ${status.stderr.trim()}`);
  if (status.stdout.trim() !== "") {
    throw new DevError(`worktree ${flag.worktree} has uncommitted changes; commit or discard them first`);
  }

  const push = await run(["git", "push", "-u", "origin", flag.branch], flag.worktree);
  if (push.exitCode !== 0) throw new DevError(`git push failed: ${push.stderr.trim()}`);

  const prUrl = await findOrCreatePr(flag.worktree, flag.branch, project.baseBranch, await titleFor(dir, workItemId), workItemId);

  if ((await azure.state(workItemId)) !== "Done") await azure.setState(workItemId, "Done");

  const next: Flag = { ...flag, status: "done", prUrl, updatedAt: new Date().toISOString() };
  await writeJson(paths.flag(dir, workItemId), next);
  report({ ok: true, workItemId, prUrl });
}

// Looks for an open pull request from the branch into the base; creates one only if none exists.
async function findOrCreatePr(cwd: string, branch: string, base: string, title: string, id: number): Promise<string> {
  const list = await run(["gh", "pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "url", "--jq", ".[0].url"], cwd);
  if (list.exitCode !== 0) throw new DevError(`gh pr list failed: ${list.stderr.trim()}`);
  const existing = list.stdout.trim();
  if (existing) return existing;

  const body = `Azure Boards work item #${id}.\n\nOpened by herdr-dev after the agent reported success.`;
  const create = await run(["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], cwd);
  if (create.exitCode !== 0) throw new DevError(`gh pr create failed: ${create.stderr.trim()}`);
  return create.stdout.trim().split(/\r?\n/).pop() ?? "";
}

async function titleFor(stateDirPath: string, id: number): Promise<string> {
  const data = await readJson<WorkItems>(paths.workItems(stateDirPath));
  const item = data?.items.find((i: WorkItem) => i.id === id);
  return item?.title ?? `Work item ${id}`;
}

try {
  await main();
} catch (err) {
  fail(err instanceof DevError ? err.message : String(err));
}
