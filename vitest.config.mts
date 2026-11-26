import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    benchmark: {
      include: ['server/test/**/*.bench.ts'],
    },
  },
});
