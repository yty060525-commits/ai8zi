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
  /** 五行计数口径版本(老库缺标记时按当前口径回填)。 */
  elementRuleVersion?: string;
  hiddenStems: string[][];
  tenGods: string[];
  naYin: string[];
  dayMaster: string;

  currentTime?: string;
  forecastRange: number[];
  relationships: RelationshipFacts;
  greatFortunes: Array<{ ganZhi: string; startYear: number; endYear: number; tenGod?: string; relationships: RelationshipFacts }>;
  /** 起运(出生到起运的跨度与公历日期)：大运各柱的起点由它决定。老记录无此字段。 */
  luckStart?: { years: number; months: number; days: number; date: string } | null;
  annualFortunes: FortunePeriod[];
  monthlyFortunes: FortunePeriod[];
  twelveLongevity: string[];
  /** 引擎按《子平真诠》取格法算定的格局：AI 必须沿用，不得另立格局名。 */
  patternFacts?: { name: string; tenGod: string; basis: string; special?: string };
  /** 引擎按日主与月令季节算定的调候事实(中文字符串)。作喜忌的「辅助判据」，非硬结论。 */
  tiaohouFacts?: string;
  /** 引擎算定的旺衰评分：AI 必须沿用此档位，不得自行重判身强身弱。 */
  strengthScore?: {
    support: number; drain: number; net: number; index: number;
    label: string; inSeason: boolean; monthHasSupport: boolean;
    detail: Array<{ pillar: string; stem: string; tenGod: string; side: string; weight: number; note?: string }>;
  };
  shenSha: { auspicious: string[]; inauspicious: string[]; items?: ShenShaItem[]; daySha?: string; dayTianShen?: string; timeTianShen?: string; ruleVersion?: string; source?: string };

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
  /** 管理员视图里服务器带回来的所属账号名；本机建的盘没有这个字段。 */
  username?: string;
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
export interface BaziAnalysisTask { taskId: string; type: BaziTaskType; year?: number; month?: number; annual?: FortunePeriod; monthly?: FortunePeriod; decade?: NonAiChart['greatFortunes'][number]; baseline?: BaziTaskResult; guide?: BaziGuide; /** 全盘总结任务用：各时段已算出的要点集合 */ findings?: AiFindings; }
/** 交给「全盘总结」的输入：本命结论 + 各时段(大运/流年/流月)已完成的分析要点。 */
export interface AiFindings {
  horizon: { from: number; to: number };
  baselineSummary: string;
  decades: Array<{ key: string; heading: string; text: string }>;
  annuals: Array<{ key: string; heading: string; text: string }>;
  monthlies: Array<{ key: string; heading: string; text: string }>;
}
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