import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { createRequire } from 'node:module';

/**
 * vite-node 1.x normalizeModuleId() strips the "node:" prefix before passing
 * the id to Vite's resolve pipeline (only "node:test" is whitelisted).
 * As a result, "node:sqlite" becomes "sqlite" which Vite can't find.
 *
 * The workaround:
 *  1. resolveId() redirects "sqlite" / "node:sqlite" to a virtual module id
 *     "\0node-sqlite" so the normalised id never hits Node's module system.
 *  2. load() for that virtual id returns a synthetic ESM shim that synchronously
 *     pulls the bindings out of the native module via createRequire().
 *
 * (An earlier attempt used `external: true` + `test.server.deps.external`, but
 * the forks pool JSON-serialises the config so RegExp patterns become {} and
 * vite-node's fetchResult() normalises "node:sqlite" to "sqlite" before the
 * shouldExternalize check, so import("sqlite") was attempted instead of
 * import("node:sqlite").)
 */
function nodeSqliteExternalPlugin(): Plugin {
  const VIRTUAL_ID = '\0node-sqlite';
  return {
    name: 'vite-plugin-node-sqlite-external',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:sqlite' || id === 'sqlite') {
        return VIRTUAL_ID;
      }
    },
    load(id) {
      if (id === VIRTUAL_ID) {
        // createRequire is synchronous and works for native Node builtins.
        const m = createRequire(import.meta.url)('node:sqlite') as Record<string, unknown>;
        // Build a named-export shim that re-exports every binding.
        const exports = Object.keys(m)
          .map((k) => `export const ${k} = _m.${k};`)
          .join('\n');
        return `import { createRequire } from 'node:module';\nconst _m = createRequire(import.meta.url)('node:sqlite');\n${exports}`;
      }
    },
  };
}

export default defineConfig({
  plugins: [nodeSqliteExternalPlugin()],
  test: {
    include: ['server/**/*.test.ts', 'web/**/*.test.ts'],
    // Use forks (child_process) pool so that process.env mutations
    // (e.g. HOME/USERPROFILE overrides in configStore tests) are visible
    // to os.homedir() on Windows — worker_threads do not propagate them.
    pool: 'forks',
  },
});
