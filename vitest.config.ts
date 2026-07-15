import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // CJS deps of the MCP SDK need pre-bundling to run inside workerd.
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ["ajv"],
          },
        },
      },
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              API_KEY: "test-master-key",
            },
          },
        },
      },
    },
  };
});
