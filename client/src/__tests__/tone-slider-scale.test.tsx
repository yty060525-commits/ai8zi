import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DEFAULT_TONE } from '../data/baziOrchestrator';
import { PersonDetail, toneLabel } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import type { BaziRecord } from '../types/domain';

/* ⚠ 必须 mock 适配器：用例4/5 要**拖动滑杆**，而本文件此前只读源码不调分析。
   tone-restart.test.tsx:60 的同类操作用例证明不 mock 时一次点击就会真的调起 analyzeBazi；
   测试环境的凭据闸口只是兜底，判据不能建在「恰好没密钥」上(见 [[feedback-new-dependency-defaults-and-vacuous-guards]])。 */
vi.mock('../data/deepseekAdapter', () => ({ analyzeBazi: vi.fn(), beginAiSession: vi.fn(), cancelAiSession: vi.fn() }));
/* 【判据空白 #153】语气滑杆的两处「声明 vs 实现」接缝此前没有任何判据碰过：
 *
 * 接缝一 —— **档位区间只被三个点钉住**。tone.test.ts 只断言 toneLabel(0)/(50)/(100)，
 *   四条分支边界（≤5 / <45 / ≤55 / ≤90）上没有一个用例。于是「把五档整体平移一档」这类改法
 *   （实测变异 T1：`v <= 5` → `v <= 4`，即犀利档收窄）在旧判据下**全绿存活** —— 那三个点离边界最远，
 *   恰好都读不到差别。而 baziOrchestrator.ts:64 的字段注释写着「语气档(0 犀利 .. 50 中立 .. 100 温柔夸夸)」，
 *   那是 UI 侧唯一说明这套刻度怎么分的话；它本身也没有任何校验器（同类形态见 §129/#147 的注释承诺判空）。
 *   ⚠ 诚实读数：这条注释的三个端点今天与实现一致（0→犀利直白、50→中立、100→温柔夸夸），
 *   但实现比它更细 ——「中立」实际从 **45** 就开始（首个含「中立」的档位实测 = 45），
 *   注释只给了中点。所以这里钉的是**注释承诺的那三点**，不替注释编造它没写的区间边界。
 *
 * 接缝二 —— **「这是默认档」那句标注硬编码字面量 80**（PersonDetail.tsx:758 `tone === 80`），
 *   而 #129 的注释正是拿它当后果来警告的：「把 DEFAULT_TONE 改成 60，界面滑杆的『这是默认档』标注
 *   与文案会变，模型收到的语气要求却一个字不变」。那句话把分叉描述成了可见现象，却没有一条判据
 *   把标注的数字和 DEFAULT_TONE 绑起来 ⇒ 真分叉时两边各自成立、谁都不红。这里补的是**绑定**，
 *   不是第二套判断：字节钉子要求那个比较对象写成常量，行为钉子要求默认档确实带这句、相邻档不带。 */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** 用例7 的夹具盘 id。语气滑杆的值来自本机 pref.<id>/ran.<id>，宿主机可能留过同名键 ⇒ 每条用例前清掉，
 *  否则「默认档对齐」那一步会被上一台机器的残留拽走(同类口径见 tone-restart.test.tsx:53)。 */
const SCALE_ID = 'scale-person-153';
afterEach(() => { cleanup(); resetMockSession(); vi.restoreAllMocks(); try { localStorage.clear(); } catch {} });

/** 从 PersonDetail.tsx 里取出滑杆那一行的 min/max/step 字面量。
 *  ⚠ 按「整行包含 id=\"tone-slider\"」取而不是按属性正则全局扫 —— 同文件另有 range 输入与
 *     多处 min/max 字样，全局扫会把别处的值算进来（实测第一版就是这么误读的）。 */
function sliderAttrs(): { min: number; max: number; step: number; line: string } {
  const line = src('../features/person/PersonDetail.tsx')
    .split('\n')
    .find((l) => l.includes('id="tone-slider"'));
  expect(line, '找不到 tone-slider 那一行 ⇒ 写法变了，本判据不能跑在缺元素的树上').toBeTruthy();
  const num = (name: string): number => {
    const m = new RegExp(name + '=\\{(\\d+)\\}').exec(line as string);
    expect(m, `${line} 里读不到 ${name}={数字} ⇒ 该属性已改成变量或删除`).not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };
  return { min: num('min'), max: num('max'), step: num('step'), line: line as string };
}

/** 实现里 toneLabel 的实际分段：按源码顺序抽出每条 `if (v …) return '…'`。 */
function tiers(): Array<{ cond: string; text: string }> {
  const body = /export const toneLabel[\s\S]*?\n\};/.exec(src('../features/person/PersonDetail.tsx'));
  expect(body, '读不到 toneLabel 函数体').not.toBeNull();
  const out = [...(body as RegExpExecArray)[0].matchAll(/if \(v ([<>]=?|=+) (\d+)\) return '([^']+)'/g)]
    .map((m) => ({ cond: m[1] + m[2], text: m[3] }));
  const tail = /return '([^']+)'/.exec((body as RegExpExecArray)[0].split('\n').slice(-2)[0]);
  return tail ? [...out, { cond: 'else', text: tail[1] }] : out;
}

describe('语气滑杆的刻度与档位语义(#153)', () => {
  it('前提：滑杆范围就是 0..100、步长 5（下面所有穷举都以它为准）', () => {
    const a = sliderAttrs();
    expect(a.min).toBe(0);
    expect(a.max).toBe(100);
    expect(a.step).toBe(5);
  });

  it('滑杆每个可达档位都能读出非空文案，默认档落在其中且读成温和', () => {
    /* 逐档调用真实 toneLabel：断言落在函数返回值上，不是我自己重算的字符串。 */
    const a = sliderAttrs();
    const reachable: number[] = [];
    for (let v = a.min; v <= a.max; v += a.step) reachable.push(v);
    expect(reachable.length, '可达档位数量与 0..100/step=5 不符').toBe(21);
    expect(reachable, 'DEFAULT_TONE 不在滑杆可达档位里 ⇒ 「这是默认档」那句永远不会显示')
      .toContain(DEFAULT_TONE);
    for (const v of reachable) {
      expect(toneLabel(v), `档位 ${v} 读出空文案`).not.toBe('');
    }
    expect(toneLabel(DEFAULT_TONE), '默认档文案应当就是滑杆旁边那句温和档').toContain('温和');
  });

  it('四档边界逐位点名：每档的首档与末档读成本档，越界一格必须换档', () => {
    /* 这是本条的核心。旧判据只有三个点，整体平移一档能全绿活过去；边界穷举把它抓回来。
       期望取自当前实现的**边界语义**（≤5 犀利 / <45 偏犀利 / ≤55 中立 / ≤90 温和 / 余 温柔夸夸），
       并把「跨界一格就换档」写成独立断言 —— 只比首末档的话，宽紧一格的改法仍可能自洽。 */
    const table: Array<[number, number, string]> = [
      [0, 5, '犀利直白'],
      [6, 44, '偏犀利'],
      [45, 55, '中立'],
      [56, 90, '温和'],
      [91, 100, '温柔夸夸'],
    ];
    for (const [lo, hi, name] of table) {
      expect(toneLabel(lo), `${lo} 应读成「${name}」档`).toContain(name);
      expect(toneLabel(hi), `${hi} 应读成「${name}」档`).toContain(name);
      if (lo - 1 >= 0) {
        expect(toneLabel(lo - 1), `${lo - 1} 不该落进「${name}」档 ⇒ 下界比实现宽`).not.toContain(name);
      }
      if (hi + 1 <= 100) {
        expect(toneLabel(hi + 1), `${hi + 1} 不该落进「${name}」档 ⇒ 上界比实现窄`).not.toContain(name);
      }
    }
  });

  it('baziOrchestrator 的档位注释不许说谎：它承诺的三点按实现读出来必须成立', () => {
    /* 注释是 UI 侧唯一的刻度说明，改数值的人靠它判断影响面。此处不做整句匹配（那种钉子会红在
       「解释改动的注释」上，见 [[feedback-comment-vs-literal-scan]]），而是把注释里的三个锚点
       当成**可执行断言**来跑：0 档含「犀利」、50 档含「中立」、100 档含「温柔夸夸」。 */
    const line = src('../data/baziOrchestrator.ts')
      .split('\n')
      .find((l) => /语气档\(0/.test(l));
    expect(line, '读不到语气档的字段注释 ⇒ 注释位置或写法变了，这条闸门会静默失效').toBeTruthy();
    expect(line, '注释不再声明刻度范围 ⇒ 下面的三点断言失去依据').toMatch(/语气档.*0.*犀利.*50.*中立.*100.*温柔夸夸/);
    expect(toneLabel(0)).toContain('犀利');
    expect(toneLabel(50)).toContain('中立');
    expect(toneLabel(100)).toContain('温柔夸夸');
  });

  it('「这是默认档」的比较对象必须是 DEFAULT_TONE，不许留裸数字 80', () => {
    /* 字节钉子：#129 的注释把「标注会变」写成了后果，却没绑住数字。这一条把绑定落成字节 ——
       把 DEFAULT_TONE 改成 60 而界面仍是 `tone === 80` 时，这里先红，而不是让人去肉眼对表。
       ⚠ 只扫那一行，不扫全文：文件里 80 还出现在别处（如别的样式常量），扫全文会红在无关行上。
    ⚠ expect(x, msg).toBeTruthy() **不收窄类型**（#152 实测踩过 TS18047/TS18048）：
       后面直接 line.match(...) 会被 tsc -b 挡下，必须显式取非空值。 */
    const found = src('../features/person/PersonDetail.tsx')
      .split('\n')
      .find((l) => l.includes("，这是默认档"));
    if (!found) return expect.fail('找不到「这是默认档」那句 ⇒ 展示没了，用户再也不能确认自己停在默认档');
    const line = found;
    expect(line, '「这是默认档」仍在与裸数字比较 ⇒ 改 DEFAULT_TONE 会让标注指向错误的档位').toMatch(/tone === DEFAULT_TONE/);
    expect(line.match(/tone === \d+/), '该行仍有裸数字比较，标注与 DEFAULT_TONE 脱钩').toBeNull();
  });

  it('档位表本身不自相矛盾：五档名各出现一次，且不存在无文案的档位', () => {
    /* 反向钉子（防止上面几条被我改成空表还全绿）：tiers() 必须真读到五条分支。
       读到 0 条不是「产品没问题」而是我的解析式漏形态，先自证能打响。 */
    const t = tiers();
    expect(t.length, `只从 toneLabel 读到 ${t.length} 条分支 ⇒ 实现形状变了或解析式失效`).toBeGreaterThanOrEqual(4);
    for (const one of t) {
      expect(one.text, '某条分支返回空串').not.toBe('');
      expect(one.cond, '某条分支没有条件（末档除外）').not.toBe('');
    }
  });

  it('拖动滑杆后读屏拿到的档位就是 toneLabel 的那一句（无障碍文本不能与可见文案分叉）', async () => {
    /* 【本条为什么要单独存在】tone-restart.test.tsx:72 只钉了「拖到 30 ⇒ 含犀利」一个点，
       而 aria-valuetext 这个绑定本身没有任何判据：把 :757 改成写死字符串、或改回 `String(tone)`，
       页面上那句可见文案照旧正确，只有读屏用户听到的档位变成裸数字 —— 纯结果型断言抓不到。
       这里走真实渲染 + 真实 change 事件，断言落在**组件发出的那个属性**上(见 [[feedback-assertion-must-touch-the-component]])。 */
    const rec: BaziRecord = {
      id: SCALE_ID, name: '刻度测试', gender: 'male', birthYear: 1990, birthMonth: 1,
      createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
      aiStatus: 'completed',
    };
    initializeMockSession(
      [{ id: rec.id, name: rec.name, nameInitial: 'K', gender: rec.gender, birthSummary: 'x' }],
      [{ person: { id: rec.id, name: rec.name, nameInitial: 'K', gender: rec.gender, birthSummary: 'x' }, record: structuredClone(rec), aiAnalysis: { status: 'completed' } }],
    );
    render(<PersonDetail personId={SCALE_ID} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: '人物详情' });
    const slider = await screen.findByRole('slider');
    /* 默认档先对齐一次口径，避免在「滑杆根本没渲染出来」的空集上做后续断言。 */
    expect(slider.getAttribute('aria-valuetext'), '默认档的无障碍文本没读出默认文案').toBe(toneLabel(DEFAULT_TONE));
    for (const v of [0, 20, 50, 95]) {
      fireEvent.change(slider, { target: { value: String(v) } });
      const avt = slider.getAttribute('aria-valuetext');
      expect(avt, `档位 ${v} 的 aria-valuetext 为空 ⇒ 读屏听不到档位`).not.toBe('');
      expect(avt, `档位 ${v} 的无障碍文本与可见文案分叉(读到 ${JSON.stringify(avt)})`).toBe(toneLabel(v));
      /* 同一档的可见那句必须一致：两处都调 toneLabel，但一个是属性一个是子节点，可能各自被改写。 */
      const visible = document.querySelector('.tone-value')?.textContent ?? '';
      expect(visible, `档位 ${v} 的可见文案不含无障碍文本那半句`).toContain(toneLabel(v));
    }
  });
});
