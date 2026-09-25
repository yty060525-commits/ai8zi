/* ── 暗门：把某个隐藏区块放出来 ─────────────────────────────────────────────
   用来开「本地系统」那块解锁 UI：平时设置页上不出现任何相关字样，
   在设置页标题上连点 5 下才现身。暗门**只在界面层**，不参与解锁——
   想真正启用本地系统仍然要在放出来的输入框里填对解锁码（见 localSystem.ts）。

   为什么不做成「输口令才显示」：那等于把暗门本身变成第二道密码，
   而它同样只能在前端校验，等于又多一块能被人读出来的东西、又多一处要维护的口令。
   连点手势零成本，也不留下任何可被搜到的线索。 */
import { useCallback, useRef } from 'react';

/** 连点几下触发。5 下：短到可以顺手点完，又不至于误触。 */
const TAPS = 5;
/** 两下之间超过这个间隔就重新数：连点要像连点，而不是零散地点了一整天。 */
const WINDOW_MS = 2000;

/** 返回一个稳定的点击处理器：在同一个元素上连点 5 下即调用 onTrigger。
 *  `enabled` 为 false 时完全不计数（不需要放出来的时候就别数）。
 *
 *  回调走 ref 而不是直接闭包引用：这个钩子的状态(taps/last)存在 useRef 里，而**同步连点**
 *  (jsdom 的 fireEvent、或用户手速极快)期间 React 还没来得及重渲染，props 里的旧回调会
 *  连着被调用 5 次 —— 于是「显示→隐藏→显示→…」来回翻转，净结果取决于次数奇偶，看起来
 *  就像暗门没反应。放进 ref 后每次触发都读最新一次渲染的闭包，状态由它自己判。 */
export function useSecretTitleTap(onTrigger: () => void, enabled = true): { onClick: () => void } {
  const taps = useRef(0);
  const last = useRef(0);
  const handler = useRef(onTrigger);
  handler.current = onTrigger;
  const onClick = useCallback(() => {
    if (!enabled) return;
    const at = Date.now();
    if (at - last.current > WINDOW_MS) taps.current = 0;
    last.current = at;
    taps.current += 1;
    if (taps.current >= TAPS) { taps.current = 0; handler.current(); }
  }, [enabled]);
  return { onClick };
}
