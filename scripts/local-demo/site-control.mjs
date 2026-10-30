/**
 * Preloaded into the `next dev` process the local demo launcher spawns (issue #248).
 *
 * The launcher cannot deliver a catchable signal to a child on every platform (on Windows,
 * `kill()` terminates the process at once, without running `next dev`'s own shutdown). Instead
 * it sends `local-demo:stop` over the IPC channel, and this hook hands it to `next dev`'s own
 * SIGTERM handling. In Next 16.3.3 that handling stops its worker and waits for it before
 * exiting; this is Next's internal behaviour, not a documented API. If the launcher itself
 * disappears, the channel closes and the hook requests the same shutdown.
 *
 * ## Only in the launcher's own child (issue #250)
 *
 * `next dev` copies its `execArgv`, and with it this `--import`, into `NODE_OPTIONS` for its
 * worker. From there the hook reaches every Node process the worker starts, including the
 * `jest-worker` that serves dynamic routes, and those processes have IPC channels of their own.
 * Listening there stalled every `/directory/<id>` request. So the hook acts only when
 * `LOCAL_DEMO_SITE_CONTROL_OWNER` names this process's parent (the launcher). It deletes that
 * variable before `next dev` starts, so no descendant inherits it, and is inert everywhere else.
 */

import process from "node:process";

const owner = process.env.LOCAL_DEMO_SITE_CONTROL_OWNER;

delete process.env.LOCAL_DEMO_SITE_CONTROL_OWNER;

if (owner !== undefined && owner === String(process.ppid) && typeof process.send === "function") {
  process.on("message", (message) => {
    if (message === "local-demo:stop") {
      process.emit("SIGTERM");
    }
  });

  process.on("disconnect", () => process.emit("SIGTERM"));
}
