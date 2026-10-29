/**
 * A module-resolution hook for the local demonstration's command-line script (issue #248).
 *
 * The application's TypeScript modules import one another **without** file extensions, which
 * Next.js and Vitest resolve but Node's own type stripping does not. This hook retries a failed
 * **relative** specifier with `.ts` appended, and changes nothing else. It is registered only by
 * `npm run demo:local*`; the application, its build and its tests never load it.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const extensionless = !/\.[cm]?[jt]sx?$/.test(specifier);

    if (error?.code === "ERR_MODULE_NOT_FOUND" && relative && extensionless) {
      return nextResolve(`${specifier}.ts`, context);
    }

    throw error;
  }
}
