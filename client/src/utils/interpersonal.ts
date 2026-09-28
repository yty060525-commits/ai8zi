// 生肖人际适配：以“我属X(年支)”给出 三合/六合/六冲/六害 对应生肖(人际/合婚参考)。
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
const SAN_HE_GROUPS = [[0, 4, 8], [1, 5, 9], [2, 6, 10], [3, 7, 11]]; // 申子辰/巳酉丑/寅午戌/亥卯未

export function zodiacOfBranch(branch: string): string {
  const idx = BRANCHES.indexOf(branch);
  return idx >= 0 ? ZODIAC[idx] : branch;
}

export function interpersonalZodiac(yearBranch: string): { sanHe: string[]; liuHe: string[]; chong: string[]; hai: string[] } {
  const b = BRANCHES.indexOf(yearBranch);
  const at = (i: number) => ZODIAC[((i % 12) + 12) % 12];
  if (b < 0) return { sanHe: [], liuHe: [], chong: [], hai: [] };
  return {
    sanHe: SAN_HE_GROUPS[b % 4].filter((i) => i !== b).map((i) => at(i)),
    liuHe: [at(1 - b)], // (a+b)%12==1
    chong: [at(b + 6)], // 六冲差6
    hai: [at(7 - b)], // (a+b)%12==7
  };
}
