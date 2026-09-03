export type Gender = 'male' | 'female';

export interface RelationshipFacts {
  sanHe: string[];
  liuHe: string[];
  chong: string[];
  xing: string[];
  hai: string[];
  po: string[];
  ke: string[];
}

export interface FortunePeriod {
  year: number;
  month: number;
  ganZhi: string;
  tenGod?: string;
  relationships: RelationshipFacts;
  relationshipDetails?: RelationshipDetail[];
}

export interface RelationshipDetail {
  type: 'sanHe' | 'liuHe' | 'chong' | 'xing' | 'hai' | 'po' | 'ke';
  sourceLayer: 'natal' | 'great-fortune' | 'annual' | 'monthly';
  sourcePillar: string;
  targetLayer: 'natal' | 'great-fortune' | 'annual' | 'monthly';
  targetPillar: string;
  status: 'complete' | 'half-combination' | 'partial-punishment' | 'binding';
}

export interface ShenShaItem {
  name: string;
  category: '吉' | '凶' | '中';
  pillarIndex: 0 | 1 | 2 | 3;   // 年0 月1 日2 时3
  position: '天干' | '地支';
  basis: string;
}

export interface NonAiChart {
  pillars: { year: string; month: string; day: string; hour: string };
  lunarDate: string;
  solarDate: string;
  zodiac: string;
  elements: Record<string, number>;
  elementRatio: Record<string, number>;
  hiddenStems: string[][];
  tenGods: string[];
  naYin: string[];
  dayMaster: string;
  fortuneStart: string;
  currentTime?: string;
  forecastRange: number[];
  relationships: RelationshipFacts;
  greatFortunes: Array<{ ganZhi: string; startYear: number; endYear: number; tenGod?: string; relationships: RelationshipFacts }>;
  annualFortunes: FortunePeriod[];
  monthlyFortunes: FortunePeriod[];
  twelveLongevity: string[];
  shenSha: { auspicious: string[]; inauspicious: string[]; items?: ShenShaItem[]; daySha?: string; dayTianShen?: string; timeTianShen?: string; ruleVersion?: string; source?: string };
  fortuneMethod: { method: 'three-days-one-year'; estimated: true; boundary: string; components: { days: number; hours: number; years: number; months: number; extraDays: number } };
  tenGodDetails: { heavenly: string[]; hidden: Array<Array<{ stem: string; tenGod: string; position: 'root' | 'middle' | 'residual' }>> };
  relationshipDetails: RelationshipDetail[];
  shenShaRuleVersion: string;
  chenggu?: { parts: { year: string; month: string; day: string; hour: string }; totalLiang: number; totalText: string; ruleVersion: string };
}

/** The deliberately small record captured by the first chart workflow. */
export interface BaziRecord {
  id: string;
  name: string;
  gender: Gender;
  birthYear: number;
  birthMonth: number;
  createdAt: string;
  yearPillar: string;
  monthPillar: string;
  dayPillar: string;
  hourPillar: string;
  nonAiResult?: NonAiChart;
  aiStatus: 'not_started' | 'pending' | 'completed' | 'failed' | 'not_configured';
  aiAnalysis?: BaziAIAnalysis;
  aiOverview?: BaziAIAnalysis;
  aiError?: string;
  aiTasks?: Record<string, BaziTaskResult>;
  /** 生成这套结果时使用的语气档(0 犀利 .. 50 中立 .. 100 温柔)，默认 80 */
  toneUsed?: number;
}

export interface BaziAIAnalysis {
  pattern: string;
  strength: string;
  usefulElements: string[];
  avoidElements: string[];
  explanation: string;
  /** 古风标题(批大运/流年时的四字对仗，可选) */
  title?: string;
  /** 结构化要点(模型按需返回，正文仍以 explanation 长文为准) */
  overall?: string;
  health?: string;
  career?: string;
  wealth?: string;
  love?: string;
  notice?: string;
}
export type BaziTaskType = 'baseline' | 'overview' | 'annual' | 'monthly' | 'synthesis' | 'decade' | 'adjustment';
export interface BaziGuide { element: '木' | '火' | '土' | '金' | '水'; lifestyle: string; career: string; health: string; }
export interface BaziAnalysisTask { taskId: string; type: BaziTaskType; year?: number; month?: number; annual?: FortunePeriod; monthly?: FortunePeriod; baseline?: BaziTaskResult; guide?: BaziGuide; }
export interface BaziTaskResult { task: BaziAnalysisTask; status: 'completed' | 'failed' | 'not_configured'; analysis?: BaziAIAnalysis; error?: string; }

export interface Person {
  id: string;
  name: string;
  nameInitial: string;
  gender: Gender;
  birthSummary: string;
}

export type AIAnalysisStatus = 'not_started' | 'pending' | 'completed' | 'failed';

export interface AIAnalysis {
  status: AIAnalysisStatus;
  result?: string;
}

export interface PersonDetailData {
  person: Person;
  record: BaziRecord;
  aiAnalysis: AIAnalysis;
}

export interface ClientRepository {
  listPersons(): Person[];
  getPerson(id: string): PersonDetailData | undefined;
}