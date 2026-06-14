import { defineConfig } from "vitest/config";
import { serviceVitestConfig } from "@rodrigo-barraza/utilities-library/vitest";

export default defineConfig({
  ...serviceVitestConfig,
  test: {
    ...serviceVitestConfig.test,
    exclude: [
      ...(serviceVitestConfig.test?.exclude || []),
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
    ],
  },
});
