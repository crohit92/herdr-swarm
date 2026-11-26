// The real Io, built from plain engine wrappers (Prims). Herdr CLI calls, the state
// directory, and Claude's trust setting. See hooks/register.tsx for where Prims come from.

import type { AgentStatus, Io, Prims, RunResult, StartResult } from "./types";
import { isUnder } from "./tick";

export const PLUGIN_ID = "dev.automation";

// The state directory: an explicit HERDR_DEV_STATE_DIR, else Herdr's default location.
// The actions check this against the directory Herdr gives them, and refuse to run
// when the two differ.
export async function resolveStateDir(prims: Prims): Promise<string> {
  const explicit = await prims.env.devStateDir();
  if (explicit) return explicit;
  const xdg = (await prims.env.xdgStateHome()) || `${(await prims.env.home()) ?? ""}/.local/state`;
  return `${xdg}/herdr/plugins/${PLUGIN_ID}`;
}

async function runJson(
  prims: Prims,
  argv: string[],
  timeoutMs = 30_000,
): Promise<{ exitCode: number; value: Record<string, any> | undefined; stdout: string; stderr: string }> {
  const r = await prims.run(argv, timeoutMs);
  let value: Record<string, any> | undefined;
  try {
    value = JSON.parse(r.stdout);
  } catch {
    value = undefined;
  }
  return { exitCode: r.exitCode, value, stdout: r.stdout, stderr: r.stderr };
}

export function makeIo(prims: Prims, stateDir: string): Io {
  const at = (rel: string) => `${stateDir}/${rel}`;

  return {
    stateDir,
    now: () => Date.now(),

    async readJson<T>(rel: string): Promise<T | undefined> {
      const path = at(rel);
      if (!(await prims.exists(path))) return undefined;
      return JSON.parse(await prims.read(path)) as T; // throws on invalid JSON; the tick reports it
    },

    async writeJson(rel: string, value: unknown) {
      await prims.write(at(rel), JSON.stringify(value, null, 2) + "\n");
    },

    async listFlagIds() {
      const dir = at("flags");
      if (!(await prims.exists(dir))) return [];
      return (await prims.list(dir))
        .map((e) => e.name.match(/^wi-(\d+)\.json$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
    },

    async countArchives(workItemId: number) {
      const dir = at("archive");
      if (!(await prims.exists(dir))) return 0;
      return (await prims.list(dir)).filter((e) => e.name.startsWith(`wi-${workItemId}-`) && e.name.endsWith(".json")).length;
    },

    async writeRequest(action: string, value: unknown) {
      await prims.write(at(`requests/${action}.json`), JSON.stringify(value) + "\n");
    },

    async invokeAction(action: string): Promise<string> {
      const r = await runJson(prims, ["herdr", "plugin", "action", "invoke", action, "--plugin", PLUGIN_ID]);
      const logId = r.value?.result?.log?.log_id;
      if (r.exitCode !== 0 || typeof logId !== "string") {
        throw new Error(`could not start ${action}: ${r.stderr.trim() || r.stdout.trim()}`);
      }
      return logId;
    },

    async runStatus(logId: string): Promise<RunResult | undefined> {
      const r = await runJson(prims, ["herdr", "plugin", "log", "list", "--plugin", PLUGIN_ID, "--limit", "200"]);
      const logs: Array<Record<string, any>> = r.value?.result?.logs ?? [];
      const log = logs.find((l) => l.log_id === logId);
      if (!log) return undefined;
      return {
        status: String(log.status ?? "unknown"),
        exitCode: typeof log.exit_code === "number" ? log.exit_code : undefined,
        stdout: String(log.stdout ?? ""),
        stderr: String(log.stderr ?? ""),
      };
    },

    async agentStatus(agentName: string): Promise<AgentStatus | undefined> {
      const r = await runJson(prims, ["herdr", "agent", "get", agentName]);
      if (r.exitCode !== 0) return undefined;
      const status = r.value?.result?.agent?.agent_status;
      return typeof status === "string" ? (status as AgentStatus) : undefined;
    },

    async sendPrompt(agentName: string, text: string): Promise<string | undefined> {
      const r = await runJson(prims, ["herdr", "agent", "prompt", agentName, text], 60_000);
      if (r.exitCode === 0) return undefined;
      return r.value?.error?.message ?? (r.stderr.trim() || "the prompt was not sent");
    },

    async startPane(worktree: string): Promise<string> {
      const current = await prims.env.panePane();
      if (!current) throw new Error("HERDR_PANE_ID is not set, so the mod cannot place the agent's pane");
      const r = await runJson(prims, ["herdr", "pane", "split", "--pane", current, "--direction", "right", "--cwd", worktree, "--no-focus"]);
      const paneId = r.value?.result?.pane?.pane_id;
      if (r.exitCode !== 0 || typeof paneId !== "string") {
        throw new Error(r.value?.error?.message ?? (r.stderr.trim() || "pane split failed"));
      }
      return paneId;
    },

    async closePane(paneId: string) {
      await prims.run(["herdr", "pane", "close", paneId], 30_000).catch(() => undefined);
    },

    async startAgent(agentName: string, paneId: string): Promise<StartResult> {
      const r = await runJson(
        prims,
        ["herdr", "agent", "start", agentName, "--kind", "claude", "--pane", paneId, "--", "--dangerously-skip-permissions"],
        120_000,
      );
      if (r.exitCode === 0 && r.value?.type === "agent_started") return { ok: true };
      const code = r.value?.error?.code;
      const message = r.value?.error?.message ?? (r.stderr.trim() || "the agent did not start");
      return { ok: false, notReady: code === "agent_not_ready", message };
    },

    async trustFolder(worktree: string, allowedRoot: string) {
      if (!isUnder(worktree, allowedRoot)) throw new Error(`${worktree} is not under ${allowedRoot}`);
      const home = (await prims.env.home()) ?? "";
      const path = `${home}/.claude.json`;
      const config = JSON.parse(await prims.read(path));
      config.projects = config.projects ?? {};
      config.projects[worktree] = { ...(config.projects[worktree] ?? {}), hasTrustDialogAccepted: true };
      await prims.write(path, JSON.stringify(config, null, 2));
    },
  };
}
