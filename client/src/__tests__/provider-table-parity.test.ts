import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* 三端各写了一份通道表：服务器 server/ai.mjs、桌面 client/src-tauri/src/lib.rs、网页直连
   deepseekAdapter.ts 的 CHANNELS。每份注释都写着「与另两端保持一致」，可这句承诺此前**没有任何
   判据**兜着 —— 改一处忘两处时，用户会看到「设置页说 Kimi 已配置，实际发出去的却是另一个模型」
   这类两头都对不上的故障。这条用例读真实源码比对，不调任何 API、不花额度。 */
/* 从本文件位置往上找仓库根（兼容路径里多出来的一层同名目录）。不靠 cwd：在不同启动方式下
   cwd 会落在 client 或仓库根；也绝不允许静默读到空内容把用例变成恒真。 */
const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    const hit = [dir, resolve(dir, 'ai 8zi')].find((g) => existsSync(resolve(g, 'server/ai.mjs')) && existsSync(resolve(g, 'client/package.json')));
    if (hit) return hit;
    dir = dirname(dir);
  }
  throw new Error('定位不到仓库根，这条用例的前提没成立');
})();
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

type Spec = { id: string; endpoint: string; model: string };

/** 从 `{ id: 'kimi', label: …, endpoint: '…', model: '…' }` 这样的字面量里取值。 */
const parseJsTable = (src: string, marker: string): Spec[] => {
  const start = src.indexOf(marker);
  expect(start, `源码里找不到 ${marker}，表结构变了要同步改这条用例`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('];', start));
  return [...body.matchAll(/\{\s*id:\s*'([^']+)'[^}]*?endpoint:\s*'([^']+)'[^}]*?model:\s*'([^']+)'/g)]
    .map(([, id, endpoint, model]) => ({ id, endpoint, model }));
};

/** Rust 侧是两条 `match provider { … => "…" }`：按同一顺序把 endpoint 与 model 配成对。 */
const parseRustTable = (src: string): Spec[] => {
  const ids = ['deepseek', 'kimi', 'qwen'];
  const rows = [...src.matchAll(/AiProvider::(Deepseek|Kimi|Qwen)\s*=>\s*"([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
  const byKind = (kind: string, pick: (v: string) => boolean) =>
    rows.filter(([k, v]) => k === kind && pick(v)).map(([, v]) => v);
  return ids.map((id) => {
    const kind = { deepseek: 'Deepseek', kimi: 'Kimi', qwen: 'Qwen' }[id]!;
    const endpoints = byKind(kind, (v) => v.startsWith('https://'));
    const models = byKind(kind, (v) => !v.startsWith('https://'));
    // lib.rs 里 provider_model 与连通性自检各写一遍：两处必须自洽，且与另一处同值。
    expect(new Set(endpoints).size, `${kind} 的端点在 Rust 内部就不一致`).toBe(1);
    expect(new Set(models).size, `${kind} 的模型在 Rust 内部就不一致（重复硬编码漂移）`).toBe(1);
    return { id, endpoint: endpoints[0], model: models[0] };
  });
};

describe('三端通道表一致', () => {
  const server: Spec[] = parseJsTable(read('server/ai.mjs'), 'export const PROVIDERS = [');
  const web: Spec[] = parseJsTable(read('client/src/data/deepseekAdapter.ts'), 'const CHANNELS: ChannelSpec[] = [');
  const desktop: Spec[] = parseRustTable(read('client/src-tauri/src/lib.rs'));

  it('三处都解析出全部三个通道(用例本身没空转)', () => {
    for (const [label, table] of [['服务器', server], ['网页直连', web], ['桌面', desktop]] as const) {
      expect(table.map((t) => t.id).sort(), `${label} 通道表解析不全`).toEqual(['deepseek', 'kimi', 'qwen']);
    }
  });

  for (const id of ['deepseek', 'kimi', 'qwen']) {
    it(`${id}：三端的端点与模型 id 必须是同一个`, () => {
      const s = server.find((t) => t.id === id)!;
      const w = web.find((t) => t.id === id)!;
      const d = desktop.find((t) => t.id === id)!;
      expect([w.endpoint, d.endpoint], `${id} 端点与服务器不一致`).toEqual([s.endpoint, s.endpoint]);
      expect([w.model, d.model], `${id} 模型 id 与服务器不一致`).toEqual([s.model, s.model]);
    });
  }
});
