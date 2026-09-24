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

/** 返回一个稳定的点击处理器：在同一个元素上连点 5 下即调用 onOpen。
 *  `enabled` 为 false 时完全不计数（已经放出来的区块不必再点）。 */
export function useSecretTitleTap(onOpen: () => void, enabled = true): { onClick: () => void } {
  const taps = useRef(0);
  const last = useRef(0);
  const onClick = useCallback(() => {
    if (!enabled) return;
    const at = Date.now();
    if (at - last.current > WINDOW_MS) taps.current = 0;
    last.current = at;
    taps.current += 1;
    if (taps.current >= TAPS) { taps.current = 0; onOpen(); }
  }, [onOpen, enabled]);
  return { onClick };
}
