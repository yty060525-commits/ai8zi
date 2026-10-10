/** server/ai.mjs 的类型面：只声明客户端判据真正调用的那几个导出。
 *  为什么写成通配模块 —— tsc 在 allowJs:false 下不会把兄弟 ai.d.ts 关联到 ai.mjs(实测两条路都无效)，
 *  `declare module '*.mjs'` 才会命中；探针见 #151 之后的构建收口记录。 */
declare module '*/server/ai.mjs' {
  export function providerLabel(id: string): string;
  export function cnCode(status: number | string): string;
  export function classifyFailure(status: number, bodyText: string): string;
  export const AI_SERVER_UNCONFIGURED: string;
}
