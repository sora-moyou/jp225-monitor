import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'web/**/*.test.ts'],
    // Use forks (child_process) pool so that process.env mutations
    // (e.g. HOME/USERPROFILE overrides in configStore tests) are visible
    // to os.homedir() on Windows — worker_threads do not propagate them.
    pool: 'forks',
  },
});
