import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* 把 public/sw.js 里的 __BUILD_ID__ 替换成当次构建的时间戳。
   为什么非要在构建时改：Service Worker 文件必须逐字节变化，浏览器才会把它
   当成「新的 SW」、走 install/activate 去清旧缓存。sw.js 内容不变就是永不更新，
   装了 PWA 的手机便永远停在旧版本(静态资源是缓存优先，命中就不联网)。 */
function swBuildId(): Plugin {
  return {
    name: 'sw-build-id',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(import.meta.dirname, 'dist/sw.js');
      const id = String(Date.now());
      const src = readFileSync(swPath, 'utf8');
      if (!src.includes('__BUILD_ID__')) throw new Error('dist/sw.js 缺少 __BUILD_ID__ 占位符，缓存将永不失效');
      writeFileSync(swPath, src.replace(/__BUILD_ID__/g, id));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), swBuildId()],
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
