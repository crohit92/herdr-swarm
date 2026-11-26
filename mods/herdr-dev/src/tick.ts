// One iteration of the herdr-dev loop. See docs/herdr-dev-design.html, sections 8 and 9.
//
// A tick does at most one thing:
//   - waits for the action run it started last time, or
//   - refreshes the queue (fetch), or
//   - judges the queue and flags, and starts one next step.
// It never blocks. Anything slow is an action run that a later tick checks.

import type {
  ActiveProject,
  AgentRecord,
  AgentResult,
  AgentStatus,
  Flag,
  Io,
  LoopState,
  Notice,
  Pending,
  TickResult,
  WorkItem,
  WorkItems,
} from "./types";

export const GRACE_MS = 2 * 60_000; // a new agent may take this long to start working
export const CLAIM_TIMEOUT_MS = 5 * 60_000; // a claim that has not finished is hanging
export const FINISH_RETRY_MS = 10 * 60_000; // a finish that has not finished is retried
export const RUN_LOOKUP_TIMEOUT_MS = 2 * 60_000; // a run missing from the plugin log is given up

export const ACTIONS = {
  fetch: "dev-fetch-work-items",
  claim: "dev-claim-work-item",
  finish: "dev-finish-work-item",
  reset: "dev-reset-work-item",
} as const;

type Ctx = {
  io: Io;
  project: ActiveProject;
  loop: LoopState;
  notices: Notice[];
  previous: Notice[];
  now: number;
};

// How many notices the pane keeps. Older info lines drop off first.
const MAX_NOTICES = 20;

// Where worktrees go: <repo-parent>/<repo>-worktrees. The only folder the mod trusts.
export function worktreesRoot(repoRoot: string): string {
  const slash = repoRoot.lastIndexOf("/");
  const parent = slash <= 0 ? "/" : repoRoot.slice(0, slash);
  const name = repoRoot.slice(slash + 1);
  return `${parent === "/" ? "" : parent}/${name}-worktrees`;
}

export function isUnder(path: string, root: string): boolean {
  return path.startsWith(root + "/");
}

// Prompt for the agent. The description is the task; the rules come after it.
export function buildPrompt(item: WorkItem, flag: Flag, resultPath: string, resumed: boolean): string {
  const lines = [
    `You are working on Azure Boards work item #${item.id} (${item.type}): ${item.title}.`,
    "",
    "Task description (the work to do, as written on the board):",
    "<<<TASK",
    item.description || "(no description)",
    "TASK>>>",
    "",
    `Work only inside this worktree: ${flag.worktree}`,
    `Branch: ${flag.branch}`,
    "",
    "Do this:",
    "1. Implement the work item in this worktree.",
    "2. Run the project's tests and fix any failures you caused.",
    `3. Commit your changes on this branch. Mention #${item.id} in the commit message.`,
    "4. Do not push and do not open a pull request. The mod does that.",
    `5. Last, write ${resultPath} as JSON: {"status": "success" or "failed", "summary": "...", "commit": "<commit id>"}.`,
    "   Write the file only after your commit is made.",
  ];
  if (resumed) {
    lines.push(
      "",
      "A previous attempt on this item ended without a result. Check the commits already in this worktree and continue from there.",
    );
  }
  return lines.join("\n");
}

// Runs one tick. `project` comes from active-project.json, read by the caller.
export async function tick(io: Io, project: ActiveProject): Promise<TickResult> {
  const loop: LoopState = (await io.readJson<LoopState>("loop.json")) ?? { running: false };
  const previous = (await io.readJson<Notice[]>("notices.json")) ?? [];
  const now = io.now();
  loop.lastTickAt = new Date(now).toISOString();

  if (!loop.running) {
    return { outcome: "stopped", stop: true, notices: previous, newNotices: [] };
  }

  const ctx: Ctx = { io, project, loop, notices: previous, previous, now };

  if (loop.pending) {
    const pending = loop.pending;
    const run = await io.runStatus(pending.logId);
    if (!run || run.status === "running") {
      if (!run && now - pending.startedAt > RUN_LOOKUP_TIMEOUT_MS) {
        ctx.notices = withNotice(ctx.notices, {
          key: `lost-run:${pending.logId}`,
          kind: "error",
          text: `${pending.kind} run ${pending.logId} was not found in the plugin log; it was given up`,
        });
        loop.pending = undefined;
      } else {
        return save(ctx, `waiting for ${pending.kind}`);
      }
    } else {
      loop.pending = undefined;
      const outcome = await afterRun(ctx, pending, run);
      return save(ctx, outcome);
    }
  }

  if (!(await freshQueue(io, loop))) {
    loop.pending = {
      kind: "fetch",
      logId: await io.invokeAction(ACTIONS.fetch),
      startedAt: now,
    };
    return save(ctx, "refreshing the queue");
  }

  const items = await io.readJson<WorkItems>("work-items.json");
  if (!items) return save(ctx, "no queue yet");

  return judge(ctx, items);
}

// The queue is fresh when its fetch is newer than the last one judged.
async function freshQueue(io: Io, loop: LoopState): Promise<boolean> {
  const items = await io.readJson<WorkItems>("work-items.json");
  if (!items) return false;
  return items.fetchedAt > (loop.lastJudgedFetchedAt ?? "");
}

// Handles the outcome of a finished action run.
async function afterRun(ctx: Ctx, pending: Pending, run: { exitCode?: number; stdout: string; stderr: string }): Promise<string> {
  const ok = run.exitCode === 0;
  const detail = (run.stderr || run.stdout).trim().split("\n").pop() ?? "";
  const id = pending.workItemId;

  if (pending.kind === "fetch") {
    if (!ok) {
      ctx.notices = withNotice(ctx.notices, { key: "fetch", kind: "error", text: `could not refresh the queue: ${detail}` });
      return "fetch failed";
    }
    const reported = lastJson(run.stdout);
    if (reported && typeof reported.stateDir === "string" && reported.stateDir !== ctx.io.stateDir) {
      ctx.loop.running = false;
      ctx.notices = withNotice(ctx.notices, {
        key: "state-dir",
        kind: "conflict",
        text: `the state directory differs: the actions use ${reported.stateDir}, the mod uses ${ctx.io.stateDir}. Set HERDR_DEV_STATE_DIR in .env to the actions' directory and start again.`,
      });
      return "stopped: state directory differs";
    }
    ctx.notices = withoutKey(ctx.notices, "fetch");
    return "queue refreshed";
  }

  if (pending.kind === "claim") {
    if (!ok) {
      ctx.notices = withNotice(ctx.notices, { key: `claim:${id}`, kind: "error", text: `could not claim #${id}: ${detail}` });
      return `claim of #${id} failed`;
    }
    ctx.notices = withoutKey(ctx.notices, `claim:${id}`);
    return `claimed #${id}`;
  }

  if (pending.kind === "finish") {
    const record = await ctx.io.readJson<AgentRecord>(`agents/wi-${id}.json`);
    if (ok) {
      if (record && record.closedAt === undefined) {
        await ctx.io.closePane(record.paneId);
        await ctx.io.writeJson(`agents/wi-${id}.json`, { ...record, closedAt: ctx.now });
      }
      const reported = lastJson(run.stdout);
      const prUrl = typeof reported?.prUrl === "string" ? reported.prUrl : "";
      ctx.notices = withNotice(ctx.notices, { key: `done:${id}`, kind: "info", text: `#${id} is Done${prUrl ? `: ${prUrl}` : ""}` });
      return `#${id} done`;
    }
    ctx.notices = withNotice(ctx.notices, { key: `finish:${id}`, kind: "error", text: `could not finish #${id}: ${detail}` });
    return `finish of #${id} failed`;
  }

  // reset
  if (!ok) {
    ctx.notices = withNotice(ctx.notices, { key: `reset:${id}`, kind: "error", text: `could not reset #${id}: ${detail}` });
    return `reset of #${id} failed`;
  }
  ctx.notices = withoutKey(ctx.notices, `reset:${id}`);
  return `reset #${id}`;
}

// Judges the flags and the queue, then starts at most one step.
async function judge(ctx: Ctx, items: WorkItems): Promise<TickResult> {
  const { io, loop } = ctx;
  loop.lastJudgedFetchedAt = items.fetchedAt;
  // Conflicts and mismatches are recomputed on every judge; errors and info stay until replaced.
  ctx.notices = ctx.notices.filter((n) => n.kind === "error" || n.kind === "info");

  const flags = new Map<number, Flag>();
  for (const id of await io.listFlagIds()) {
    let flag: Flag | undefined;
    try {
      flag = await io.readJson<Flag>(`flags/wi-${id}.json`);
    } catch {
      ctx.notices = withNotice(ctx.notices, {
        key: `unreadable:${id}`,
        kind: "conflict",
        text: `the flag for #${id} is not valid JSON. Fix or remove flags/wi-${id}.json.`,
      });
      return save(ctx, `blocked: unreadable flag for #${id}`);
    }
    if (flag) flags.set(id, flag);
  }

  // Mismatches: report only.
  const byId = new Map(items.items.map((i) => [i.id, i]));
  for (const flag of flags.values()) {
    const item = byId.get(flag.workItemId);
    if (!item) {
      mismatch(ctx, flag.workItemId, `the flag is ${flag.status} but #${flag.workItemId} is not in the queue`);
      continue;
    }
    const expected = expectedStates(flag.status);
    if (!expected.includes(item.state)) {
      mismatch(ctx, flag.workItemId, `the flag is ${flag.status} but Azure says "${item.state}" (expected ${expected.join(" or ")})`);
    }
  }
  for (const item of items.items) {
    if (item.state !== "To Do" && !flags.has(item.id)) {
      mismatch(ctx, item.id, `Azure says "${item.state}" but there is no flag for it`);
    }
  }

  // One run at a time: any flag still in progress blocks new work.
  const inProgress = [...flags.values()].filter((f) => f.status !== "done").sort((a, b) => a.workItemId - b.workItemId);
  for (const flag of inProgress) {
    const step = await handleInProgress(ctx, flag, byId);
    if (step) return save(ctx, step);
  }
  if (inProgress.length > 0) {
    return save(ctx, `waiting: ${inProgress.map((f) => `#${f.workItemId} ${f.status}`).join(", ")}`);
  }

  // Pick the top To Do item. Smaller priority number wins, then smaller id.
  const todo = items.items.filter((i) => i.state === "To Do").sort(byPriority);
  if (todo.length === 0) return save(ctx, "skipped: no To Do items");

  const top = todo[0]!;
  if (flags.has(top.id)) {
    const flag = flags.get(top.id)!;
    ctx.notices = withNotice(ctx.notices, {
      key: `top-flagged:${top.id}`,
      kind: "conflict",
      text: `#${top.id} is first in the queue but already has a flag (${flag.status}). Nothing else starts until you decide.`,
    });
    return save(ctx, `blocked: #${top.id} already has a flag`);
  }

  const attempts = await io.countArchives(top.id);
  if (attempts >= ctx.project.maxAttempts) {
    ctx.notices = withNotice(ctx.notices, {
      key: `cap:${top.id}`,
      kind: "conflict",
      text: `#${top.id} has been ended ${attempts} times, the limit is ${ctx.project.maxAttempts}. It is not started again; check the archive in the state directory.`,
    });
    return save(ctx, `blocked: #${top.id} reached the attempt limit`);
  }

  const started = new Date(ctx.now).toISOString();
  await io.writeJson(`flags/wi-${top.id}.json`, {
    workItemId: top.id,
    status: "claiming",
    attempt: attempts + 1,
    startedAt: started,
    updatedAt: started,
  } satisfies Flag);
  await io.writeRequest("claim", { workItemId: top.id });
  loop.pending = { kind: "claim", logId: await io.invokeAction(ACTIONS.claim), workItemId: top.id, startedAt: ctx.now };
  return save(ctx, `claiming #${top.id}`);
}

// Returns the outcome when this flag caused a step, or undefined when it only waits.
async function handleInProgress(ctx: Ctx, flag: Flag, byId: Map<number, WorkItem>): Promise<string | undefined> {
  const id = flag.workItemId;
  const age = ctx.now - Date.parse(flag.updatedAt);

  if (flag.status === "claiming") {
    if (age > CLAIM_TIMEOUT_MS) return reset(ctx, flag, "the claim did not finish within 5 minutes");
    return undefined;
  }

  if (flag.status === "finishing") {
    if (age > FINISH_RETRY_MS) {
      await startFinish(ctx, flag);
      return `retrying finish of #${id}`;
    }
    return undefined;
  }

  // doing
  const item = byId.get(id);
  return handleDoing(ctx, flag, item);
}

async function handleDoing(ctx: Ctx, flag: Flag, item: WorkItem | undefined): Promise<string | undefined> {
  const { io } = ctx;
  const id = flag.workItemId;
  const recordRead = await io.readJson<AgentRecord>(`agents/wi-${id}.json`);
  const record = recordRead && recordRead.closedAt === undefined ? recordRead : undefined;

  if (!record) return startAgent(ctx, flag, item);

  const status: AgentStatus | undefined = await io.agentStatus(record.agentName);
  const result = await io.readJson<AgentResult>(`results/wi-${id}.json`);
  const sinceStart = ctx.now - record.startedAt;

  if (status === "working") {
    if (!record.sawWorking) await io.writeJson(`agents/wi-${id}.json`, { ...record, sawWorking: true });
    return undefined;
  }

  if (status === "blocked") {
    ctx.notices = withNotice(ctx.notices, {
      key: `blocked:${id}`,
      kind: "conflict",
      text: `#${id}: the agent is waiting for input in its pane. Answer it there.`,
    });
    return undefined;
  }

  if (status === "idle" || status === "done") {
    if (result) {
      if (result.status === "success") {
        await startFinish(ctx, flag);
        return `finishing #${id}`;
      }
      ctx.notices = withNotice(ctx.notices, {
        key: `failed:${id}`,
        kind: "conflict",
        text: `#${id}: the agent reported failure${result.summary ? `: ${result.summary}` : ""}. Decide: fix it by hand, or reset the item.`,
      });
      return undefined;
    }
    if (!record.promptSent && status === "idle") {
      const error = await io.sendPrompt(record.agentName, buildPrompt(item ?? emptyItem(id), flag, `${io.stateDir}/results/wi-${id}.json`, flag.attempt > 1));
      if (error) {
        ctx.notices = withNotice(ctx.notices, { key: `prompt:${id}`, kind: "error", text: `#${id}: could not send the prompt: ${error}` });
        return undefined;
      }
      await io.writeJson(`agents/wi-${id}.json`, { ...record, promptSent: true });
      return `sent the prompt to the agent for #${id}`;
    }
    if (!record.sawWorking && sinceStart <= GRACE_MS) return undefined;
    return reset(ctx, flag, record.sawWorking ? "the agent stopped without writing a result" : "the agent stopped before starting work");
  }

  // The agent is not known to Herdr (undefined or unknown).
  if (record.sawWorking || sinceStart > GRACE_MS) return reset(ctx, flag, "the agent is no longer running");
  return undefined;
}

// Starts the agent for a freshly claimed item: trust the worktree, open a pane, start Claude.
async function startAgent(ctx: Ctx, flag: Flag, item: WorkItem | undefined): Promise<string | undefined> {
  const { io, project } = ctx;
  const id = flag.workItemId;
  const root = worktreesRoot(project.repoRoot);

  if (!flag.worktree || !isUnder(flag.worktree, root)) {
    return reset(ctx, flag, "the worktree is not under the worktree folder, so it is not trusted");
  }
  if (!item) return reset(ctx, flag, "the item is not in the queue");

  const name = `wi-${id}`;
  if ((await io.agentStatus(name)) !== undefined) {
    ctx.notices = withNotice(ctx.notices, {
      key: `name-in-use:${id}`,
      kind: "conflict",
      text: `#${id}: an agent named ${name} is already running. Close it, then reset the item.`,
    });
    return undefined;
  }

  try {
    await io.trustFolder(flag.worktree, root);
  } catch (err) {
    return reset(ctx, flag, `could not trust the worktree: ${message(err)}`);
  }

  let paneId: string;
  try {
    paneId = await io.startPane(flag.worktree);
  } catch (err) {
    return reset(ctx, flag, `could not open a pane: ${message(err)}`);
  }

  const started = await io.startAgent(name, paneId);
  if (!started.ok && !started.notReady) {
    await io.closePane(paneId);
    return reset(ctx, flag, `the agent could not start: ${started.message}`);
  }

  await io.writeJson(`agents/wi-${id}.json`, {
    workItemId: id,
    agentName: name,
    paneId,
    worktree: flag.worktree,
    startedAt: ctx.now,
    sawWorking: false,
    promptSent: false,
  } satisfies AgentRecord);
  await io.writeJson(`flags/wi-${id}.json`, { ...flag, agentName: name, updatedAt: new Date(ctx.now).toISOString() });
  return `started the agent for #${id}`;
}

// Moves the flag to finishing (unless it already is) and starts the finish action.
async function startFinish(ctx: Ctx, flag: Flag): Promise<void> {
  const id = flag.workItemId;
  const updated: Flag = { ...flag, status: "finishing", updatedAt: new Date(ctx.now).toISOString() };
  await ctx.io.writeJson(`flags/wi-${id}.json`, updated);
  await ctx.io.writeRequest("finish", { workItemId: id });
  ctx.loop.pending = { kind: "finish", logId: await ctx.io.invokeAction(ACTIONS.finish), workItemId: id, startedAt: ctx.now };
}

// Ends a flag: closes the agent's pane, then has the reset action archive the flag and set To Do.
async function reset(ctx: Ctx, flag: Flag, reason: string): Promise<string> {
  const { io } = ctx;
  const id = flag.workItemId;
  const record = await io.readJson<AgentRecord>(`agents/wi-${id}.json`);
  if (record && record.closedAt === undefined) {
    await io.closePane(record.paneId);
    await io.writeJson(`agents/wi-${id}.json`, { ...record, closedAt: ctx.now });
  }
  await io.writeRequest("reset", { workItemId: id, reason });
  ctx.loop.pending = { kind: "reset", logId: await io.invokeAction(ACTIONS.reset), workItemId: id, startedAt: ctx.now };
  ctx.notices = withNotice(ctx.notices, { key: `reset-reason:${id}`, kind: "info", text: `#${id} is being reset: ${reason}` });
  return `resetting #${id}: ${reason}`;
}

function expectedStates(status: Flag["status"]): string[] {
  switch (status) {
    case "claiming":
      return ["To Do", "Doing"];
    case "doing":
      return ["Doing"];
    case "finishing":
      return ["Doing", "Done"];
    case "done":
      return ["Done"];
  }
}

function mismatch(ctx: Ctx, id: number, text: string): void {
  ctx.notices = withNotice(ctx.notices, { key: `mismatch:${id}`, kind: "mismatch", text: `#${id}: ${text}` });
}

function byPriority(a: WorkItem, b: WorkItem): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.id - b.id;
}

function emptyItem(id: number): WorkItem {
  return { id, title: `work item ${id}`, type: "Task", state: "Doing", tags: [], description: "" };
}

function withNotice(list: Notice[], notice: Notice): Notice[] {
  return [...list.filter((n) => n.key !== notice.key), notice];
}

function withoutKey(list: Notice[], key: string): Notice[] {
  return list.filter((n) => n.key !== key);
}

function lastJson(text: string): Record<string, unknown> | undefined {
  const lines = text.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]!);
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // not JSON; keep looking
    }
  }
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function save(ctx: Ctx, outcome: string): Promise<TickResult> {
  ctx.loop.lastOutcome = outcome;
  const current = ctx.notices.slice(-MAX_NOTICES);
  await ctx.io.writeJson("loop.json", ctx.loop);
  await ctx.io.writeJson("notices.json", current);
  const seen = new Set(ctx.previous.map((n) => n.key));
  return {
    outcome,
    stop: !ctx.loop.running,
    notices: current,
    newNotices: current.filter((n) => !seen.has(n.key)),
  };
}
