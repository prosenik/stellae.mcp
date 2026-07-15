import type { D1Migration } from "@cloudflare/workers-types/experimental";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    API_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
