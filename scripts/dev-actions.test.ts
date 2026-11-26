// Tests for the herdr-dev library and actions.
// Azure CLI and GitHub CLI are replaced by fake scripts on PATH; git runs for real
// against a temporary repository with a bare "origin".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveFlag,
  attemptsSoFar,
  branchName,
  htmlToText,
  parseEnv,
  queueWiql,
  readProjectSettings,
  slugify,
  worktreePath,
  writeJson,
  paths,
} from "./dev-lib";

const SCRIPTS = join(import.meta.dir);

describe("pure helpers", () => {
  test("slugify keeps names short and safe", () => {
    expect(slugify("Fix the Login Redirect!!")).toBe("fix-the-login-redirect");
    expect(slugify("   ")).toBe("work");
    expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  test("branch and worktree names follow the design", () => {
    expect(branchName(12, "Login fix")).toBe("feature/wi-12-login-fix");
    expect(worktreePath("/code/herdr-swarm", 12)).toBe("/code/herdr-swarm-worktrees/wi-12");
  });

  test("parseEnv skips comments, strips quotes, keeps the last value", () => {
    const env = parseEnv('# c\nA=1\nB="two"\n\nC=\'three\'\nA=4\n');
    expect(env).toEqual({ A: "4", B: "two", C: "three" });
  });

  test("project settings: interval is required and at least 30", () => {
    expect(() => readProjectSettings({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "p" })).toThrow("HERDR_DEV_INTERVAL_SECONDS is required");
    expect(() => readProjectSettings({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "p", HERDR_DEV_INTERVAL_SECONDS: "10" })).toThrow("at least 30");
    const ok = readProjectSettings({ AZURE_DEVOPS_ORG: "o", AZURE_DEVOPS_PROJECT: "p", HERDR_DEV_INTERVAL_SECONDS: "60" });
    expect(ok).toEqual({ intervalSeconds: 60, baseBranch: "main", maxAttempts: 3 });
  });

  test("project settings: missing Azure keys are all named", () => {
    expect(() => readProjectSettings({ HERDR_DEV_INTERVAL_SECONDS: "60" })).toThrow("AZURE_DEVOPS_ORG is required; AZURE_DEVOPS_PROJECT is required");
  });

  test("WIQL quotes the project name and limits states", () => {
    const wiql = queueWiql("Auto'mation");
    expect(wiql).toContain("[System.TeamProject] = 'Auto''mation'");
    expect(wiql).toContain("IN ('To Do', 'Doing', 'Done')");
  });

  test("htmlToText strips tags and decodes entities", () => {
    expect(htmlToText("<div>Tom &amp; Jerry<br>x&lt;y</div>")).toBe("Tom & Jerry\nx<y");
  });
});

describe("flags and archives", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dev-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("archiving moves the flag out and counts as an attempt", async () => {
    await writeJson(paths.flag(dir, 7), { workItemId: 7, status: "doing", attempt: 1, startedAt: "t", updatedAt: "t" });
    expect(await attemptsSoFar(dir, 7)).toBe(0);
    await archiveFlag(dir, 7, "agent stopped");
    expect(existsSync(paths.flag(dir, 7))).toBe(false);
    expect(await attemptsSoFar(dir, 7)).toBe(1);
    const [name] = await readdir(paths.archiveDir(dir));
    const archived = JSON.parse(await readFile(join(paths.archiveDir(dir), name!), "utf8"));
    expect(archived.reason).toBe("agent stopped");
    expect(archived.previousFlag.status).toBe("doing");
  });
});

// Integration: the three state-changing actions, with fake az and gh on PATH.
describe("actions against a temporary repository", () => {
  let root: string;
  let stateDirPath: string;
  let fakeBin: string;
  let repo: string;
  let env: Record<string, string>;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  }

  async function runAction(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const p = Bun.spawn(["bun", join(SCRIPTS, script)], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HERDR_DEV_STATE_DIR: stateDirPath, FAKE_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { exitCode: await p.exited, stdout, stderr };
  }

  async function azState(id: number): Promise<string> {
    return (await readFile(join(root, `state-${id}`), "utf8")).trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-actions-"));
    stateDirPath = join(root, "state");
    fakeBin = join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(stateDirPath, { recursive: true });

    // origin: a bare repo with one commit on main.
    const origin = join(root, "origin.git");
    await mkdir(origin);
    await git(origin, "init", "--bare", "-b", "main");
    repo = join(root, "herdr-swarm");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-u", "origin", "main");
    env = {};

    // Fake az: reads and writes state-<id> files; query prints one item.
    await writeFile(
      join(fakeBin, "az"),
      `#!/bin/sh
case "$*" in
  *"work-item show"*) cat "$FAKE_DIR/state-$(echo "$*" | sed -E 's/.*--id ([0-9]+).*/\\1/')" ;;
  *"work-item update"*)
    id=$(echo "$*" | sed -E 's/.*--id ([0-9]+).*/\\1/')
    case "$*" in
      *"--state To Do"*) echo "To Do" > "$FAKE_DIR/state-$id" ;;
      *"--state Doing"*) echo "Doing" > "$FAKE_DIR/state-$id" ;;
      *"--state Done"*) echo "Done" > "$FAKE_DIR/state-$id" ;;
      *) echo "bad state: $*" >&2; exit 2 ;;
    esac ;;
  *"boards query"*) echo '[]' ;;
  *) echo "unexpected az: $*" >&2; exit 2 ;;
esac
`,
    );
    await chmod(join(fakeBin, "az"), 0o755);

    // Fake gh: pr list returns nothing the first time; pr create prints a URL and records itself.
    await writeFile(
      join(fakeBin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "pr list") if [ -f "$FAKE_DIR/pr-exists" ]; then echo "https://example.test/pr/1"; fi ;;
  "pr create") touch "$FAKE_DIR/pr-exists"; echo "https://example.test/pr/1" ;;
  *) echo "unexpected gh: $*" >&2; exit 2 ;;
esac
`,
    );
    await chmod(join(fakeBin, "gh"), 0o755);

    await writeJson(paths.activeProject(stateDirPath), {
      repoRoot: repo,
      azureProject: "Automation",
      intervalSeconds: 60,
      baseBranch: "main",
      maxAttempts: 3,
      stateDir: stateDirPath,
      startedAt: new Date().toISOString(),
    });
    await writeJson(paths.workItems(stateDirPath), {
      fetchedAt: new Date().toISOString(),
      project: "Automation",
      items: [{ id: 5, title: "Fix login", type: "Task", state: "To Do", tags: [], description: "" }],
    });
    await writeFile(join(root, "state-5"), "To Do\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("claim: sets Doing, creates the worktree, flag becomes doing", async () => {
    await writeJson(paths.flag(stateDirPath, 5), { workItemId: 5, status: "claiming", attempt: 1, startedAt: "t", updatedAt: "t" });
    await writeJson(paths.request(stateDirPath, "claim"), { workItemId: 5 });

    const r = await runAction("dev-claim-work-item.ts");
    expect(r.exitCode).toBe(0);
    expect(await azState(5)).toBe("Doing");
    const flag = JSON.parse(await readFile(paths.flag(stateDirPath, 5), "utf8"));
    expect(flag.status).toBe("doing");
    expect(flag.branch).toBe("feature/wi-5-fix-login");
    expect(existsSync(join(flag.worktree, "README.md"))).toBe(true);
    expect(existsSync(paths.request(stateDirPath, "claim"))).toBe(false);
  });

  test("claim: an item that is not To Do is archived and nothing changes", async () => {
    await writeFile(join(root, "state-5"), "Doing\n");
    await writeJson(paths.flag(stateDirPath, 5), { workItemId: 5, status: "claiming", attempt: 1, startedAt: "t", updatedAt: "t" });
    await writeJson(paths.request(stateDirPath, "claim"), { workItemId: 5 });

    const r = await runAction("dev-claim-work-item.ts");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"Doing" in Azure, not "To Do"');
    expect(existsSync(paths.flag(stateDirPath, 5))).toBe(false);
    expect(await attemptsSoFar(stateDirPath, 5)).toBe(1);
    expect(await azState(5)).toBe("Doing");
  });

  test("finish: pushes, opens the PR, sets Done, flag becomes done", async () => {
    // Simulate the claimed state: worktree with one commit.
    const worktree = worktreePath(repo, 5);
    await git(repo, "worktree", "add", "-b", "feature/wi-5-fix-login", worktree, "origin/main");
    await writeFile(join(worktree, "fix.txt"), "fixed\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-m", "fix login");
    await writeFile(join(root, "state-5"), "Doing\n");
    await writeJson(paths.flag(stateDirPath, 5), {
      workItemId: 5, status: "finishing", attempt: 1, branch: "feature/wi-5-fix-login", worktree, startedAt: "t", updatedAt: "t",
    });
    await writeJson(paths.result(stateDirPath, 5), { status: "success", summary: "fixed", commit: "abc" });
    await writeJson(paths.request(stateDirPath, "finish"), { workItemId: 5 });

    const r = await runAction("dev-finish-work-item.ts");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("https://example.test/pr/1");
    expect(await azState(5)).toBe("Done");
    expect(await git(repo, "ls-remote", "--heads", "origin", "feature/wi-5-fix-login")).toContain("feature/wi-5-fix-login");
    const flag = JSON.parse(await readFile(paths.flag(stateDirPath, 5), "utf8"));
    expect(flag.status).toBe("done");
    expect(flag.prUrl).toBe("https://example.test/pr/1");
  });

  test("finish: uncommitted changes stop it and the flag stays finishing", async () => {
    const worktree = worktreePath(repo, 5);
    await git(repo, "worktree", "add", "-b", "feature/wi-5-fix-login", worktree, "origin/main");
    await writeFile(join(worktree, "dirty.txt"), "not committed\n");
    await writeJson(paths.flag(stateDirPath, 5), {
      workItemId: 5, status: "finishing", attempt: 1, branch: "feature/wi-5-fix-login", worktree, startedAt: "t", updatedAt: "t",
    });
    await writeJson(paths.result(stateDirPath, 5), { status: "success" });
    await writeJson(paths.request(stateDirPath, "finish"), { workItemId: 5 });

    const r = await runAction("dev-finish-work-item.ts");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
    const flag = JSON.parse(await readFile(paths.flag(stateDirPath, 5), "utf8"));
    expect(flag.status).toBe("finishing");
  });

  test("finish: a failed agent result is refused", async () => {
    const worktree = worktreePath(repo, 5);
    await git(repo, "worktree", "add", "-b", "feature/wi-5-fix-login", worktree, "origin/main");
    await writeJson(paths.flag(stateDirPath, 5), {
      workItemId: 5, status: "finishing", attempt: 1, branch: "feature/wi-5-fix-login", worktree, startedAt: "t", updatedAt: "t",
    });
    await writeJson(paths.result(stateDirPath, 5), { status: "failed" });
    await writeJson(paths.request(stateDirPath, "finish"), { workItemId: 5 });

    const r = await runAction("dev-finish-work-item.ts");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"failed"');
  });

  test("reset: archives the flag with the reason, sets To Do, keeps the worktree", async () => {
    const worktree = worktreePath(repo, 5);
    await git(repo, "worktree", "add", "-b", "feature/wi-5-fix-login", worktree, "origin/main");
    await writeFile(join(root, "state-5"), "Doing\n");
    await writeJson(paths.flag(stateDirPath, 5), {
      workItemId: 5, status: "doing", attempt: 1, branch: "feature/wi-5-fix-login", worktree, startedAt: "t", updatedAt: "t",
    });
    await writeJson(paths.request(stateDirPath, "reset"), { workItemId: 5, reason: "agent stopped without a result" });

    const r = await runAction("dev-reset-work-item.ts");
    expect(r.exitCode).toBe(0);
    expect(await azState(5)).toBe("To Do");
    expect(existsSync(paths.flag(stateDirPath, 5))).toBe(false);
    expect(await attemptsSoFar(stateDirPath, 5)).toBe(1);
    expect(existsSync(worktree)).toBe(true);
  });

  test("reset: refuses a finishing flag", async () => {
    await writeJson(paths.flag(stateDirPath, 5), { workItemId: 5, status: "finishing", attempt: 1, startedAt: "t", updatedAt: "t" });
    await writeJson(paths.request(stateDirPath, "reset"), { workItemId: 5, reason: "x" });

    const r = await runAction("dev-reset-work-item.ts");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('refusing to reset a flag in "finishing" state');
    expect(existsSync(paths.flag(stateDirPath, 5))).toBe(true);
  });
});
