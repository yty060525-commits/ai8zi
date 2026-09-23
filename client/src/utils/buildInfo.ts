/** 当前构建版本：与 sw.js 的缓存号同源(同一次构建生成的同一个时间戳)。
 *  构建时由 vite.config.ts 的 define 注入；测试/开发环境无注入时回退为 unknown，
 *  不至于让 UI 崩掉。 */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';

/** 构建时间戳 → 可读版本号。用本地时区的「月-日 时:分」，一眼能比新旧。
 *  同一次构建里 UI 显示与 SW 缓存号是同一个 id，所以看到哪个时间就是哪一版。 */
export function buildLabel(id: string = BUILD_ID): string {
  if (!/^\d{10,}$/.test(id)) return id;
  const at = new Date(Number(id));
  if (Number.isNaN(at.getTime())) return id;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** SW 缓存号(mingli-<id>)：用于核对手机实际激活的是哪一版缓存。 */
export function cacheLabel(id: string = BUILD_ID): string {
  return 'mingli-' + id;
}

/** git 版本号「提交序号-短哈希」，与 scripts/version.sh 的快照名同源：
 *  UI 上看到这串，就能直接 `version.sh restore <同名快照>` 回退。非 git 构建时为空。 */
export const GIT_VERSION: string = typeof __GIT_VERSION__ === 'string' ? __GIT_VERSION__ : '';

/** 完整版本标签：有 git 号时优先显示它(可回退)，否则退回构建时间。 */
export function versionLabel(): string {
  return GIT_VERSION || buildLabel();
}
