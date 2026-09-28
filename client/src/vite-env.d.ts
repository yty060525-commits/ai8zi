/// <reference types="vite/client" />

// Vite 资源查询：?raw 把文件内容作为字符串导入
declare module '*?raw' { const src: string; export default src; }

// 构建时注入的版本戳(见 vite.config.ts 的 define)，与 sw.js 的 CACHE 号同源
declare const __BUILD_ID__: string;
// 构建时注入的 git 版本号「提交序号-短哈希」；非 git 环境下为空串
declare const __GIT_VERSION__: string;
