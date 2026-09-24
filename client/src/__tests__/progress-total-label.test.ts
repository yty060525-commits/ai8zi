import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* 进度条那句「任务 x / y」在第一次回调之前走的是界面自己估的分母：编排器只在每条任务真正
   收尾后才发 progress，而它自己会补上「后天调整」「全盘总结」两个占位(totalShown)。
   界面这边提前把 +2 摆出来，就会出现「0 / 25」而实际只跑 23 条 —— 文案与真实队列不同源。
   这里钉住：未拿到进度前不许报总数。 */

const src = readFileSync(resolve(__dirname, '../features/person/PersonDetail.tsx'), 'utf8');

describe('进度总数只在编排器给出后才显示', () => {
  it('排队阶段不写死分母，避免虚报总项数', () => {
    expect(src, '进度文案又回到界面自估的 queuedTotal() 分母').toMatch(
      /\{progress \? progress\.done \+ ' \/ ' \+ progress\.total : '0'\}/,
    );
  });
});
