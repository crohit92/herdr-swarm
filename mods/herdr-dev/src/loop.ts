// The loop around one tick: the timer, start and stop, and the status text.
// Takes plain functions (Prims) and a publish callback from the hook; it never sees $.

import { parseEnv, readProjectSettings } from "./config";
import { makeIo, resolveStateDir } from "./io";
import { tick } from "./tick";
import type { ActiveProject, LoopState, Notice, Prims, TickResult, WorkItems } from "./types";

// Shows a tick's result: the status line, the notices, and toasts for new ones.
export type Publish = (result: TickResult) => Promise<void>;

let cancelTimer: (() => void) | undefined;
let busy = false;

export function stopTimer(): void {
  cancelTimer?.();
  cancelTimer = undefined;
}

export function armTimer(prims: Prims, seconds: number, publish: Publish): void {
  stopTimer();
  cancelTimer = prims.every(seconds * 1000, () => {
    void runOnce(prims, publish);
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadProject(prims: Prims): Promise<ActiveProject | undefined> {
  const io = makeIo(prims, await resolveStateDir(prims));
  return io.readJson<ActiveProject>("active-project.json");
}

export async function loadLoop(prims: Prims, stateDir: string): Promise<LoopState> {
  const io = makeIo(prims, stateDir);
  return (await io.readJson<LoopState>("loop.json")) ?? { running: false };
}

// One iteration. A timer that fires during a running tick is skipped.
export async function runOnce(prims: Prims, publish: Publish): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const project = await loadProject(prims);
    if (!project) {
      stopTimer();
      return;
    }
    const result = await tick(makeIo(prims, project.stateDir), project);
    await publish(result);
    if (result.stop) stopTimer();
  } catch (err) {
    const text = `the tick failed: ${errorMessage(err)}`;
    const notice: Notice = { key: "tick-error", kind: "error", text };
    await publish({ outcome: text, stop: false, notices: [notice], newNotices: [notice] });
  } finally {
    busy = false;
  }
}

export async function gitRoot(prims: Prims): Promise<string> {
  const r = await prims.run(["git", "rev-parse", "--show-toplevel"], 30_000);
  if (r.exitCode !== 0) throw new Error("not inside a git repository. Run /herdr-dev start from the target project.");
  return r.stdout.trim();
}

export async function startLoop(prims: Prims, publish: Publish): Promise<string> {
  const repo = await gitRoot(prims);
  const envPath = `${repo}/.env`;
  if (!(await prims.exists(envPath))) {
    throw new Error(`no .env in ${repo}. Add AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT and HERDR_DEV_INTERVAL_SECONDS.`);
  }
  const env = parseEnv(await prims.read(envPath));
  const settings = readProjectSettings(env);
  if (!env.AZURE_DEVOPS_PROJECT) throw new Error("AZURE_DEVOPS_PROJECT is required");

  const stateDir = await resolveStateDir(prims);
  const io = makeIo(prims, stateDir);
  const project: ActiveProject = {
    repoRoot: repo,
    azureProject: env.AZURE_DEVOPS_PROJECT,
    intervalSeconds: settings.intervalSeconds,
    baseBranch: settings.baseBranch,
    maxAttempts: settings.maxAttempts,
    stateDir,
    startedAt: new Date().toISOString(),
  };
  await io.writeJson("active-project.json", project);
  const loop = await loadLoop(prims, stateDir);
  await io.writeJson("loop.json", { ...loop, running: true });

  armTimer(prims, project.intervalSeconds, publish);
  void runOnce(prims, publish);
  return `herdr-dev started: every ${project.intervalSeconds}s for ${project.azureProject} (${repo}).`;
}

export async function stopLoop(prims: Prims): Promise<string> {
  stopTimer();
  const project = await loadProject(prims);
  if (project) {
    const loop = await loadLoop(prims, project.stateDir);
    await makeIo(prims, project.stateDir).writeJson("loop.json", { ...loop, running: false });
  }
  return "herdr-dev stopped. Agents already running were not stopped; their panes stay open.";
}

export async function statusText(prims: Prims): Promise<string> {
  const project = await loadProject(prims);
  if (!project) return "herdr-dev has not been started in this project. Run /herdr-dev start.";
  const io = makeIo(prims, project.stateDir);
  const loop = await loadLoop(prims, project.stateDir);
  const items = await io.readJson<WorkItems>("work-items.json");
  const lines = [
    `running: ${loop.running ? "yes" : "no"}, every ${project.intervalSeconds}s for ${project.azureProject}`,
    `repo: ${project.repoRoot}`,
    `last tick: ${loop.lastTickAt ?? "never"}, outcome: ${loop.lastOutcome ?? "none"}`,
  ];
  if (loop.pending) lines.push(`waiting for: ${loop.pending.kind} run ${loop.pending.logId}`);
  if (items) {
    lines.push(`queue (fetched ${items.fetchedAt}):`);
    for (const item of items.items.slice(0, 10)) lines.push(`  #${item.id} ${item.state} ${item.title}`);
  }
  return lines.join("\n");
}
