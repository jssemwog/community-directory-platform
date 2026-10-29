/**
 * Preloaded into the `next dev` process the local demo launcher spawns (issue #248).
 *
 * The launcher cannot deliver a catchable signal to a child on every platform (on Windows,
 * `kill()` terminates the process at once, without running `next dev`'s own shutdown). Instead
 * it sends `local-demo:stop` over the IPC channel, and this hook hands it to `next dev`'s own
 * SIGTERM handling. In Next 16.3.3 that handling stops its worker and waits for it before
 * exiting; this is Next's internal behaviour, not a documented API. If the launcher itself
 * disappears, the channel closes and the hook requests the same shutdown.
 */

import process from "node:process";

if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message === "local-demo:stop") {
      process.emit("SIGTERM");
    }
  });

  process.on("disconnect", () => process.emit("SIGTERM"));
}
