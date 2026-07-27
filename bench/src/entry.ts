import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the calling module is the process entry point.
 *
 * The two benchmark scripts make network calls, so a module that fires its main
 * function merely on being imported would turn a unit test into a live run. Both
 * sides are resolved through `realpathSync` because the entry path and
 * `import.meta.url` disagree about symlinks, and a plain string compare would
 * silently never match under a linked runner — which fails in the safe
 * direction, but by never running the script at all.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
