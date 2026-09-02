import type { Person, PersonDetailData, NonAiChart } from '../../types/domain';

const sampleNonAiResult: NonAiChart = {
  pillars: { year: '甲子', month: '丙寅', day: '庚午', hour: '壬午' }, lunarDate: '庚午年正月初一', solarDate: '1990-01-01', zodiac: '鼠',
  elements: { 木: 1, 火: 2, 土: 0, 金: 1, 水: 1 }, elementRatio: { 木: 0.2, 火: 0.4, 土: 0, 金: 0.2, 水: 0.2 },
  hiddenStems: [['癸'], ['甲', '丙', '戊'], ['丁', '己'], ['丁', '己']], tenGods: ['正财', '偏财', '日主', '食神'], naYin: ['海中金', '炉中火', '路旁土', '杨柳木'], dayMaster: '庚', fortuneStart: '1993-01-01', forecastRange: [2025, 2026],
  relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] },
  greatFortunes: [{ ganZhi: '丁卯', startYear: 1993, endYear: 2002, relationships: { sanHe: [], liuHe: [], chong: [], xing: [], hai: [], po: [], ke: [] } }],
  annualFortunes: [], monthlyFortunes: [], currentTime: '2025-01-01T00:00:00.000Z', twelveLongevity: ['沐浴', '绝', '死', '死'], shenSha: { auspicious: ['天德'], inauspicious: ['五虚'], ruleVersion: 'lunar-javascript-1.7.7-day-shen-sha', source: 'lunar-javascript' }, fortuneMethod: { method: 'three-days-one-year', estimated: true, boundary: '1990-02-04', components: { days: 3, hours: 0, years: 1, months: 0, extraDays: 0 } }, tenGodDetails: { heavenly: ['正财', '偏财', '日主', '食神'], hidden: [] }, relationshipDetails: [], shenShaRuleVersion: 'lunar-javascript-1.7.7-day-shen-sha',
};

export const mockPeople: Person[] = [
  { id: 'zhang-wei', name: '张伟', nameInitial: 'Z', gender: 'male', birthSummary: '甲子年 丙寅月 庚午日' },
  { id: 'li-ming', name: '李明', nameInitial: 'L', gender: 'male', birthSummary: '乙丑年 戊辰月 辛未日' },
  { id: 'wang-fang', name: '王芳', nameInitial: 'W', gender: 'female', birthSummary: '丙寅年 庚午月 壬申日' },
];

export const mockPersonDetails: PersonDetailData[] = [
  { person: mockPeople[0], record: { id: 'zhang-wei-record', name: '张伟', gender: 'male', birthYear: 1990, birthMonth: 1, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午', nonAiResult: sampleNonAiResult, aiStatus: 'completed' }, aiAnalysis: { status: 'completed', result: '适合稳步推进长期计划。' } },
  { person: mockPeople[1], record: { id: 'li-ming-record', name: '李明', gender: 'male', birthYear: 1985, birthMonth: 3, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '乙丑', monthPillar: '戊辰', dayPillar: '辛未', hourPillar: '甲午', aiStatus: 'not_started' }, aiAnalysis: { status: 'not_started' } },
  { person: mockPeople[2], record: { id: 'wang-fang-record', name: '王芳', gender: 'female', birthYear: 1992, birthMonth: 5, createdAt: '2025-01-01T00:00:00.000Z', yearPillar: '丙寅', monthPillar: '庚午', dayPillar: '壬申', hourPillar: '乙巳', aiStatus: 'pending' }, aiAnalysis: { status: 'pending' } },
];
