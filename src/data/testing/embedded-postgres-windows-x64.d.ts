/**
 * The shape of `@embedded-postgres/windows-x64`, declared because the package is **absent on
 * every platform but Windows** (issue #185).
 *
 * `embedded-postgres` lists it among its `optionalDependencies`, and the package itself declares
 * `os: ["win32"], cpu: ["x64"]` — so npm installs it only on Windows x64. On Linux, which is
 * what CI runs, it is simply not there, and a bare `import` of it fails type resolution with
 * `TS2307` even though the runtime code never executes that import off Windows.
 *
 * This declaration states what the package exports **when it is present**, which is exactly
 * what it does export — its own `dist/index.d.ts` reads:
 *
 * ```ts
 * export declare const pg_ctl: string;
 * export declare const initdb: string;
 * export declare const postgres: string;
 * ```
 *
 * Only `pg_ctl` is declared here, because only `pg_ctl` is used: declaring the other two would
 * invite a later author to reach for `initdb` or `postgres` on the strength of a type, and
 * neither is permitted by the issue #185 ruling.
 *
 * **This is a type declaration, not a dependency.** Nothing is installed, `package.json` and
 * the lockfile are untouched, and the runtime still treats the package as **optional**: the
 * import is gated on `win32`, wrapped in a `try`, and its failure is a cleanup failure with a
 * fixed, path-free message. A declaration asserting the shape of a module that may be absent is
 * the same contract an `@types/*` package provides, and it is sound here precisely because the
 * code that imports it already proves the module is present before it relies on it.
 */
declare module "@embedded-postgres/windows-x64" {
  /** Absolute path to the bundled `pg_ctl` executable, resolved by the package itself. */
  export const pg_ctl: string;
}
