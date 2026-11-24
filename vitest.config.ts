import { configDefaults, defineConfig } from "vitest/config";

// Two tiers. `npm test` runs the unit tier: in-process tests with no child
// processes. `npm run test:smoke` runs files named `*.smoke.test.ts`: anything
// that spawns a process, drives a pseudo-terminal, or packs a tarball. A bare
// `vitest run` runs both.
export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    // Fails fast when src/gui/client.generated.ts is older than its sources.
    globalSetup: ["test/support/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/**/*.smoke.test.ts"],
        },
      },
      {
        extends: true,
        test: { name: "smoke", include: ["test/**/*.smoke.test.ts"] },
      },
    ],
  },
});
