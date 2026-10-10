/* 【判据空白 #150 · 界面半边】大运「顺排/逆排」这一句必须真的渲染在详情页上。

   luck-direction-display.test.ts 钉的是引擎真值与文案函数的同源；那份判据即便全绿，也仍然可能
   「函数写对了但没人把它铺进 DOM」——这正是本项目反复踩过的形状(见 [[feedback-assertion-must-touch-the-component]])。
   本文件走真实组件 PersonDetail：先证明这句读不出来(夹具前提)，再证明男/女两条盘各读出什么。

   ⚠ 变异口径：把 <p className="luck-direction"> 整行删掉 ⇒ 本文件红；
     只改文案函数不改这里 ⇒ 另一份判据红。两侧分开才盖住「算—说—显示」这条链。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PersonDetail } from '../features/person/PersonDetail';
import { initializeMockSession, resetMockSession } from '../data/clientRepository';
import { calculateNonAi } from '../features/chart/nonAiCalculator';
import type { BaziRecord, Person, PersonDetailData } from '../types/domain';

/** 己未年(阴干)：阳男/阴女的性别翻转就能让同一张盘读出两个方向，是最省事的对照夹具。 */
const PILLARS = { yearPillar: '己未', monthPillar: '乙亥', dayPillar: '甲午', hourPillar: '庚午' };
const chartMale = calculateNonAi({ birthYear: 1979, birthMonth: 11, ...PILLARS }, 'male');
const chartFemale = calculateNonAi({ birthYear: 1979, birthMonth: 11, ...PILLARS }, 'female');

const fixture = (id: string, gender: 'male' | 'female', name: string): { people: Person[]; details: PersonDetailData[] } => {
  const record = {
    id, name, gender, birthYear: 1979, birthMonth: 11,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...PILLARS,
    aiStatus: 'completed', nonAiResult: structuredClone(gender === 'male' ? chartMale : chartFemale),
  } as unknown as BaziRecord;
  const person: Person = { id, name, nameInitial: 'J', gender, birthSummary: '己未年' };
  return { people: [person], details: [{ person, record: structuredClone(record), aiAnalysis: { status: 'completed', result: 'x' } }] };
};

/** 大运小节里那句排法读数；渲染不出返回空串(交给下面的前提判红)。 */
async function directionReading(id: string): Promise<string> {
  render(<PersonDetail personId={id} onBack={vi.fn()} />);
  try {
    const row = await screen.findByText(/^排法：/, {}, { timeout: 2000 });
    return row.textContent?.trim() ?? '';
  } catch {
    return '';
  } finally {
    cleanup();
  }
}

const MALE = fixture('dir-male', 'male', '男命');
const FEMALE = fixture('dir-female', 'female', '女命');

beforeEach(() => {
  initializeMockSession([...MALE.people, ...FEMALE.people], [...MALE.details, ...FEMALE.details]);
});
afterEach(() => { cleanup(); resetMockSession(); });

describe('#150 大运排法方向必须渲染在详情页', () => {
  it('夹具前提：两句都渲染得出来(否则下面的相等/不等断言在空集上永真)', async () => {
    expect(chartMale.greatFortunes?.[0]?.ganZhi).not.toBe(chartFemale.greatFortunes?.[0]?.ganZhi);
    expect(await directionReading('dir-male'), '详情页没渲染出「排法：…」这一行').not.toBe('');
    expect(await directionReading('dir-female')).not.toBe('');
  });

  it('阴男读成逆排、阴女读成顺排，且带出依据与月柱起点', async () => {
    expect(await directionReading('dir-male')).toBe('排法：逆排(阴男阳女逆行)，自月柱乙亥起每十年一柱');
    expect(await directionReading('dir-female')).toBe('排法：顺排(阳男阴女顺行)，自月柱乙亥起每十年一柱');
  });

  it('这一行落在「大运」小节内，而不是随便挂在页面某处', async () => {
    render(<PersonDetail personId="dir-male" onBack={vi.fn()} />);
    const section = await screen.findByRole('region', { name: '大运' });
    expect(section.textContent, '大运小节里没有排法那句').toContain('排法：逆排');
    cleanup();
  });
});
