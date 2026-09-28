import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* 把 public/sw.js 里的 __BUILD_ID__ 替换成当次构建的时间戳。
   为什么非要在构建时改：Service Worker 文件必须逐字节变化，浏览器才会把它
   当成「新的 SW」、走 install/activate 去清旧缓存。sw.js 内容不变就是永不更新，
   装了 PWA 的手机便永远停在旧版本(静态资源是缓存优先，命中就不联网)。
   同一个 id 经 define 注入前端，UI 上显示构建版本 —— 手机装的是哪一版，一眼可辨。 */
const BUILD_ID = String(Date.now());

/** 可读版本号：git 提交序号 + 短哈希，与 scripts/version.sh 的快照名同源，便于对着 tag 回退。
 *  取不到 git(非仓库、shallow、无 HEAD)时留空，UI 只显示时间戳构建号。 */
function gitVersion(): string {
  const repo = resolve(import.meta.dirname, '..');
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return `${git(['rev-list', '--count', 'HEAD'])}-${git(['rev-parse', '--short', 'HEAD'])}`;
  } catch { return ''; }
}
const GIT_VERSION = gitVersion();

function buildStamp(): Plugin {
  return {
    name: 'sw-build-id',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(import.meta.dirname, 'dist/sw.js');
      const src = readFileSync(swPath, 'utf8');
      if (!src.includes('__BUILD_ID__')) throw new Error('dist/sw.js 缺少 __BUILD_ID__ 占位符，缓存将永不失效');
      writeFileSync(swPath, src.replace(/__BUILD_ID__/g, BUILD_ID));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), buildStamp()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __GIT_VERSION__: JSON.stringify(GIT_VERSION) },
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // 每个测试文件加载前先上网络闸口：任何用例都不许真连外部 AI 服务(见 src/test-setup/netGuard.ts)
    setupFiles: ['./src/test-setup/netGuard.ts'],
  },
});
