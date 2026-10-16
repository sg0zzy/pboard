import { defineConfig } from 'vitest/config';

// Test this checkout only; embedded .delta worktrees have their own dependencies/history.
export default defineConfig({
  test: { include: ['tests/**/*.test.{ts,tsx,mjs}'] }
});
