// herdr-dev: the /herdr-dev command, the loop timer, and the pane that lists conflicts.
//
// Commands:
//   /herdr-dev start   read the target project's .env, record the project, run the loop
//   /herdr-dev stop    stop the timer; running agents keep going
//   /herdr-dev status  show the loop, the queue and open notices
//
// The engine rule: a hook's $ may only be spelled $.noun.method(...) where it is called.
// So each hook builds its own plain `prims` and `publish` from $ and hands only those on.

import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";
import { armTimer, errorMessage, loadLoop, loadProject, runOnce, startLoop, statusText, stopLoop } from "../src/loop";
import type { Notice, Prims, TickResult } from "../src/types";

const PANE = "herdr-dev";

const notices = atom({ plugin: "herdr-dev", key: "notices" } as const, [], { shape: "notices-1" });
const status = atom({ plugin: "herdr-dev", key: "status" } as const, "", { shape: "status-1" });

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    const prims: Prims = {
      exists: p => $.fs.exists(p),
      read: p => $.fs.read(p),
      write: (p, text) => $.fs.write(p, text),
      list: async p => (await $.fs.list(p)).map(f => ({ name: f.name })),
      env: {
        devStateDir: () => $.env.get("HERDR_DEV_STATE_DIR"),
        xdgStateHome: () => $.env.get("XDG_STATE_HOME"),
        home: () => $.env.get("HOME"),
        panePane: () => $.env.get("HERDR_PANE_ID"),
      },
      run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
      every: (ms, fn) => {
        const timer = $.clock.every(ms, fn);
        return () => timer.cancel();
      },
    };
    const publish = async (result: TickResult) => {
      await update($, status, () => result.outcome);
      await update($, notices, () => result.notices);
      for (const n of result.newNotices) $.ui.toast(`herdr-dev: ${n.text}`);
    };

    await $.command.register({
      name: "herdr-dev",
      description: "Start, stop or inspect the herdr-dev loop: /herdr-dev start | stop | status",
    });

    // A loop that was running before a reload or restart carries on from its files.
    try {
      const project = await loadProject(prims);
      if (project && (await loadLoop(prims, project.stateDir)).running) {
        armTimer(prims, project.intervalSeconds, publish);
        void runOnce(prims, publish);
      }
    } catch {
      // No readable project yet: nothing to resume.
    }
    return next(e);
  });

  on("command.run", { command: "herdr-dev" }, async ($, e) => {
    const prims: Prims = {
      exists: p => $.fs.exists(p),
      read: p => $.fs.read(p),
      write: (p, text) => $.fs.write(p, text),
      list: async p => (await $.fs.list(p)).map(f => ({ name: f.name })),
      env: {
        devStateDir: () => $.env.get("HERDR_DEV_STATE_DIR"),
        xdgStateHome: () => $.env.get("XDG_STATE_HOME"),
        home: () => $.env.get("HOME"),
        panePane: () => $.env.get("HERDR_PANE_ID"),
      },
      run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
      every: (ms, fn) => {
        const timer = $.clock.every(ms, fn);
        return () => timer.cancel();
      },
    };
    const publish = async (result: TickResult) => {
      await update($, status, () => result.outcome);
      await update($, notices, () => result.notices);
      for (const n of result.newNotices) $.ui.toast(`herdr-dev: ${n.text}`);
    };

    const sub = e.args.trim().split(/\s+/)[0] || "status";
    try {
      if (sub === "start") return { text: await startLoop(prims, publish) };
      if (sub === "stop") return { text: await stopLoop(prims) };
      if (sub === "status") {
        void $.ui.open({ id: PANE, title: "herdr-dev" });
        return { text: await statusText(prims) };
      }
      return { text: "usage: /herdr-dev start | stop | status" };
    } catch (err) {
      return { text: `herdr-dev: ${errorMessage(err)}` };
    }
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const list: Notice[] = await read($, notices);
    const line = await read($, status);
    return (
      <Box flexDirection="column">
        <Text>{line || "Not started. Run /herdr-dev start in a project."}</Text>
        {list.length === 0 && <Text dimColor>No conflicts or mismatches.</Text>}
        {list.map(n => (
          <Text dimColor={n.kind === "info"}>
            {n.kind}: {n.text}
          </Text>
        ))}
      </Box>
    );
  });
};

