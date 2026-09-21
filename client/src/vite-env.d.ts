/// <reference types="vite/client" />

// Vite 资源查询：?raw 把文件内容作为字符串导入
declare module '*?raw' { const src: string; export default src; }
