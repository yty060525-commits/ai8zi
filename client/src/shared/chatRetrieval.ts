export interface ChatSource {
  kind: 'natal' | 'period' | 'analysis';
  recordId: string;
  heading: string;
  taskId?: string;
  taskType?: 'baseline' | 'overview' | 'annual' | 'monthly' | 'synthesis' | 'decade' | 'adjustment';
  year?: number;
  month?: number;
  sections: string[];
  text?: string;
  origin?: 'record' | 'task_cache';
}

/** JSON with sorted object keys; arrays keep their semantic order. */
export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((entry) => entry === undefined ? null : normalize(entry));
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') out[key] = normalize(entry);
      }
      return out;
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return null;
    return item;
  };
  return JSON.stringify(normalize(value));
}

const NATAL_LABELS: Record<string, string> = {
  gender: '性别', birthYear: '出生年份', pillars: '四柱', solarDate: '公历日期', lunarDate: '农历日期', zodiac: '生肖', dayMaster: '日主',
  elements: '五行计数', elementRatio: '五行比例', hiddenStems: '地支藏干', tenGods: '十神', naYin: '纳音', twelveLongevity: '十二长生',
  patternFacts: '格局事实', strengthScore: '旺衰评分', tiaohouFacts: '调候参考', shenSha: '神煞', relationships: '干支关系',
  tenGodDetails: '藏干十神', chenggu: '袁天罡称骨', fortuneDirection: '大运排法', zodiacCompatibility: '生肖人际适配',
};

export function factLabels(value: Record<string, unknown>, labels = NATAL_LABELS): string[] {
  const hasValue = (item: unknown): boolean => item !== undefined && item !== null
    && !(typeof item === 'string' && item.trim() === '')
    && (Array.isArray(item) ? item.some(hasValue)
      : item && typeof item === 'object' ? Object.values(item as Record<string, unknown>).some(hasValue) : true);
  return Object.keys(value).filter((key) => hasValue(value[key])).map((key) => labels[key] ?? '命盘事实');
}

export function sectionNames(text: string): string[] {
  return [...new Set([...String(text || '').matchAll(/【([^】]+)】/g)].map((match) => match[1]))];
}

export function uncoveredTopics(text: string, topics: string[]): string[] {
  const sections = sectionNames(text);
  const sectionTopics = new Set(['健康', '事业', '财运', '爱情', '刑冲克害批注', '后天调整', '事业适配', '健康注意', '核心结论', '值得关注的时间节点', '行动建议', '身强身弱与喜忌']);
  return topics.filter((topic) => sectionTopics.has(topic) && !sections.some((section) => section.includes(topic)));
}
