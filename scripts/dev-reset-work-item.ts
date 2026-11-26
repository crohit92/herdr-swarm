// Herdr action: dev-reset-work-item
//
// Ends a claiming or doing flag so the item can be picked up again. This action:
//   1. refuses a flag that is "finishing" or "done",
//   2. archives the flag with the reason the mod gave,
//   3. sets the work item back to To Do in Azure,
// and keeps the worktree and branch, so the next attempt can resume them.
// The mod closes the agent's pane and decides whether to retry.

import {
  DevError,
  archiveFlag,
  azure,
  fail,
  readFlag,
  report,
  stateDir,
  takeRequest,
} from "./dev-lib";

const dir = stateDir();

async function main(): Promise<void> {
  const { workItemId, reason } = await takeRequest<{ workItemId: number; reason: string }>(dir, "reset");
  const flag = await readFlag(dir, workItemId);
  if (!flag) throw new DevError(`no flag for work item ${workItemId}`);
  if (flag.status === "finishing" || flag.status === "done") {
    throw new DevError(`refusing to reset a flag in "${flag.status}" state`);
  }

  await archiveFlag(dir, workItemId, reason || "reset");
  if ((await azure.state(workItemId)) !== "To Do") await azure.setState(workItemId, "To Do");
  report({ ok: true, workItemId, status: "reset" });
}

try {
  await main();
} catch (err) {
  fail(err instanceof DevError ? err.message : String(err));
}
