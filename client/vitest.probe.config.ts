import { defineConfig } from 'vitest/config';

/* 取证脚本专用配置：src/__tests__/*.probe.ts 打印真实盘读数并写进 .scratch/，
   不进全量跑（每次写死绝对路径、耗时无判据）。跑法：npx vitest run --config vitest.probe.config.ts */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.probe.ts'],
    setupFiles: ['./src/test-setup/netGuard.ts'],
  },
});
