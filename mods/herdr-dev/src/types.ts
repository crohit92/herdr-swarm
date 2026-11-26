// Data shapes shared by the mod's logic and its I/O.
// They match the files the herdr-dev actions write in the state directory.

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

export type ActionKind = "fetch" | "claim" | "finish" | "reset";

// An action run the mod started and is waiting for in the plugin log.
export type Pending = {
  kind: ActionKind;
  logId: string;
  workItemId?: number;
  startedAt: number;
};

export type LoopState = {
  running: boolean;
  pending?: Pending;
  lastJudgedFetchedAt?: string;
  lastTickAt?: string;
  lastOutcome?: string;
};

// The mod's record of the agent for one item. closedAt is set when its pane is closed.
export type AgentRecord = {
  workItemId: number;
  agentName: string;
  paneId: string;
  worktree: string;
  startedAt: number;
  sawWorking: boolean;
  promptSent: boolean;
  closedAt?: number;
};

// What the agent writes to results/wi-<id>.json when it finishes.
export type AgentResult = {
  status: "success" | "failed";
  summary?: string;
  commit?: string;
};

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type NoticeKind = "conflict" | "mismatch" | "error" | "info";

// A line for the user. Each has a stable key so the pane updates in place and a toast fires once.
export type Notice = {
  key: string;
  kind: NoticeKind;
  text: string;
};

// The state of one action run in the plugin log.
export type RunResult = {
  status: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
};

export type StartResult = { ok: true } | { ok: false; notReady: boolean; message: string };

export type TickResult = {
  outcome: string;
  stop: boolean;
  notices: Notice[];
  newNotices: Notice[];
};

// Everything the tick logic needs from the outside world. The real implementation
// calls Herdr, the filesystem and ~/.claude.json; tests supply a fake.
export interface Io {
  readonly stateDir: string;
  now(): number;
  // Paths are relative to the state directory. Returns undefined when the file is missing;
  // throws when the file exists but is not valid JSON.
  readJson<T>(relPath: string): Promise<T | undefined>;
  writeJson(relPath: string, value: unknown): Promise<void>;
  listFlagIds(): Promise<number[]>;
  countArchives(workItemId: number): Promise<number>;
  writeRequest(action: string, value: unknown): Promise<void>;
  // Starts a plugin action and returns the plugin log id of that run.
  invokeAction(action: string): Promise<string>;
  runStatus(logId: string): Promise<RunResult | undefined>;
  agentStatus(agentName: string): Promise<AgentStatus | undefined>;
  sendPrompt(agentName: string, text: string): Promise<string | undefined>;
  startPane(worktree: string): Promise<string>;
  closePane(paneId: string): Promise<void>;
  startAgent(agentName: string, paneId: string): Promise<StartResult>;
  // Marks a worktree as trusted in Claude's settings. Throws when the path is not allowed.
  trustFolder(worktree: string, allowedRoot: string): Promise<void>;
}

// Plain functions for the engine calls the mod makes. Each hook builds these from its
// own $ (the engine rule does not allow passing $ or its nouns to helpers), and the
// shared code receives only these functions.
export type Prims = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  list(path: string): Promise<Array<{ name: string }>>;
  // One thunk per variable, so each $.env.get call names its variable literally.
  env: {
    devStateDir(): Promise<string | undefined>;
    xdgStateHome(): Promise<string | undefined>;
    home(): Promise<string | undefined>;
    panePane(): Promise<string | undefined>;
  };
  run(argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  every(ms: number, fn: () => void): () => void;
};
