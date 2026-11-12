import { mergeConfig } from "vite-plus";
import { e2e } from "../../vitest.shared.mts";

export default mergeConfig(e2e, {
  test: { globalSetup: ["./e2e/global-setup.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
