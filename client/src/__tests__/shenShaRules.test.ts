import { describe, expect, it } from 'vitest';
import { computeShenSha } from '../features/chart/shenSha';

const B = '子丑寅卯辰巳午未申酉戌亥';
const names = (p: string[]) => computeShenSha(p).map((i) => i.name + '@' + ['年','月','日','时'][i.pillarIndex] + (i.position === '天干' ? '干' : '支'));

describe('神煞起法核对(逐条对古诀)', () => {
  it('亡神：申子辰见亥、巳酉丑见申、寅午戌见巳、亥卯未见寅', () => {
    const want: Record<string,string> = { 申:'亥', 子:'亥', 辰:'亥', 巳:'申', 酉:'申', 丑:'申', 寅:'巳', 午:'巳', 戌:'巳', 亥:'寅', 卯:'寅', 未:'寅' };
    for (const [base, target] of Object.entries(want)) {
      const hit = names(['甲' + base, '甲子', '甲子', target + (target==='亥'||target==='寅'?0:0)].map((s, i) => (i === 3 ? '甲' + target : s)));
      expect(hit.some((h) => h.startsWith('亡神@时支'))).toBe(true);
    }
  });
  it('天德贵人按月支：子巳 丑庚 寅丁 卯申 辰壬 巳辛 午亥 未甲 申癸 酉寅 戌丙 亥乙', () => {
    const table: Array<[string, string, '干'|'支']> = [['子','巳','支'],['丑','庚','干'],['寅','丁','干'],['卯','申','支'],['辰','壬','干'],['巳','辛','干'],['午','亥','支'],['未','甲','干'],['申','癸','干'],['酉','寅','支'],['戌','丙','干'],['亥','乙','干']];
    for (const [mb, target, kind] of table) {
      const p = kind === '干'
        ? ['甲子', '甲' + mb, target + '子', '甲子']
        : ['甲子', '甲' + mb, '甲' + target, '甲子'];
      expect(names(p).some((h) => h.startsWith('天德贵人@' + (kind === '干' ? '日干' : '日支')))).toBe(true);
    }
  });
  it('羊刃只论五阳干(甲卯 丙午 戊午 庚酉 壬子)，阴干一律不排', () => {
    for (const [d, blade] of [['甲','卯'],['丙','午'],['戊','午'],['庚','酉'],['壬','子']]) {
      expect(names([d+'子', d+blade, d+'子', d+'子']).some((h)=>h.startsWith('羊刃@月支'))).toBe(true);
    }
    for (const [d, branch] of [['乙','寅'],['丁','巳'],['己','巳'],['辛','申'],['癸','亥']]) {
      expect(names([d+'子', d+branch, d+'子', d+'子']).some((h)=>h.startsWith('羊刃'))).toBe(false);
    }
  });
  it('禄神用「阴阳同宫」：乙禄在卯？否 —— 乙禄在寅的说法属长生表，神煞仍按通行禄位', () => {
    // 传统禄神表：甲寅 乙卯 丙巳 丁午 戊巳 己午 庚申 辛酉 壬亥 癸子(与三命通会一致)
    const lu: Record<string,string> = { 甲:'寅', 乙:'卯', 丙:'巳', 丁:'午', 戊:'巳', 己:'午', 庚:'申', 辛:'酉', 壬:'亥', 癸:'子' };
    for (const [d, b] of Object.entries(lu)) {
      expect(names(['甲子', '甲子', d + '子', d + b]).some((h)=>h.startsWith('禄神@时支'))).toBe(true);
    }
  });
});
