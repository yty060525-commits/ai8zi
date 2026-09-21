import { describe, expect, it } from 'vitest';
import { derivePattern, scoreStrength } from '../features/chart/nonAiCalculator';

/* 《子平真诠》论刃·禄劫 / 论食神 篇原文所载真实命例 —— 逐条核对本引擎的取格与旺衰。
 * 这些是古籍自己给出的判定，属最高可信度的对照样本。 */
type Row = { name: string; p: string[]; want: RegExp; note?: string };

describe('古籍命例对照(《子平真诠》)', () => {
  const rows: Row[] = [
    // 论刃篇：阳刃者…惟五阳有之
    { name: '丙生午月 阳刃', p: ['甲午','癸酉','庚寅','戊寅'], want: /^阳刃/, note: '穆同知：庚生酉月？不，此盘酉月为羊刃格' },
    { name: '贾平章 戊生午月', p: ['甲寅','庚午','戊申','甲寅'], want: /^阳刃/, note: '煞两透而根太重，食以制之' },
    { name: '丙戌丁酉庚申壬午', p: ['丙戌','丁酉','庚申','壬午'], want: /^阳刃/, note: '庚生酉月＝阳刃；官煞竞出、壬合丁官' },
    // 论禄劫：建禄者，月建逢禄堂也…皆以透干支，别取财官煞食为用
    { name: '张状元 甲生寅月', p: ['甲子','丙寅','甲子','丙寅'], want: /^建禄用(食神|伤官)/, note: '木火通明＝禄劫用伤食' },
    { name: '平章 辛丑庚寅甲辰乙亥', p: ['辛丑','庚寅','甲辰','乙亥'], want: /^建禄用(正官|七杀)/, note: '合煞留官' },
    { name: '辛亥庚寅甲申丙寅', p: ['辛亥','庚寅','甲申','丙寅'], want: /^建禄用/, note: '制煞留官' },
    { name: '王少师 庚午戊子癸卯丁巳', p: ['庚午','戊子','癸卯','丁巳'], want: /^建禄用(正官|正财|偏财)/, note: '癸生子月建禄；官而兼带财印(三奇)' },
    { name: '李知府 丁酉丙午丁巳壬寅', p: ['丁酉','丙午','丁巳','壬寅'], want: /^建禄用(正官)/, note: '丁生午月建禄，用官而财助' },
    { name: '己未己巳丁未辛丑', p: ['己未','己巳','丁未','辛丑'], want: /^建禄用(食神|伤官|偏财|正财)/, note: '化劫为财' },
    { name: '高尚书 庚子甲申庚子甲申', p: ['庚子','甲申','庚子','甲申'], want: /^建禄用/, note: '庚生申月建禄；化劫为生(用财)' },
    { name: '娄参政 丁巳壬子癸卯己未', p: ['丁巳','壬子','癸卯','己未'], want: /^建禄用(七杀|正官)/, note: '禄劫用煞' },
    { name: '戊辰癸亥壬午丙午', p: ['戊辰','癸亥','壬午','丙午'], want: /^建禄用/, note: '壬生亥月建禄；合煞存财' },
    { name: '癸卯庚申庚子庚辰', p: ['癸卯','庚申','庚子','庚辰'], want: /^建禄用/, note: '金水相涵＝禄劫用伤食' },
    { name: '甲子丙子癸丑壬辰', p: ['甲子','丙子','癸丑','壬辰'], want: /^建禄用/, note: '张都统：癸生子月建禄，禄劫用财带伤食' },
    { name: '己酉乙亥壬戌庚子', p: ['己酉','乙亥','壬戌','庚子'], want: /^建禄用/, note: '王总兵：禄格用官而伤官并透，庚合乙去伤存官' },
  ];
  for (const r of rows) {
    it(r.name + ' → ' + r.note, () => {
      const day = r.p[2][0];
      const got = derivePattern(r.p, day);
      console.log('CASE', r.name.padEnd(24), '=>', got.name.padEnd(12), '|', got.basis.slice(0, 46));
      expect(got.name).toMatch(r.want);
    });
  }
});

describe('阳刃只论五阳干(古籍明载「惟五阳有之」)', () => {
  it('乙生寅月不得称阳刃(阴干无刃)', () => {
    const r = derivePattern(['戊子','甲寅','乙亥','丙子'], '乙');
    console.log('YINBLADE', r.name, '|', r.basis);
    expect(r.name.startsWith('阳刃')).toBe(false);
    expect(/阳刃/.test(r.basis)).toBe(false);
  });
  it('阳刃支必为禄前一位：甲卯 丙戊午 庚酉 壬子', () => {
    const bladeOf: Record<string,string> = { 甲:'卯', 丙:'午', 戊:'午', 庚:'酉', 壬:'子' };
    for (const [day, branch] of Object.entries(bladeOf)) {
      const r = derivePattern(['甲子', '甲' + branch, day + '子', '甲子'], day);
      console.log('BLADE', day, branch, '=>', r.name);
      expect(r.name.startsWith('阳刃')).toBe(true);
    }
  });
});
