/* =============================================================================
 * 正文中文闸门 —— 三端唯一的「只能中文」判据
 *
 * 为什么单独成模块：这段逻辑原先在 client/src/features/chart/elements.ts 与
 * server/chat.mjs 各手抄一份，改一处忘另一处就会让同一命盘在不同通道给出
 * 干净度不同的正文(服务器漏一个括号、浏览器却整段拦掉)。现在两端 import 同一份。
 *
 * 口径：模型答案里只许出现汉字、空白/换行，以及命理文本离不开的顿号、逗号、
 * 冒号、句号、问号、分号、感叹号。字母、数字、括号、引号、书名号一律不许有。
 * 「限制死」的实现方式是**判据比清洗更严**：清洗器自己若漏掉某个符号，闸门当场
 * 判失败并返回空串，由调用方按「该通道没给出可用中文」处理 —— 宁可没答案，
 * 也不把半句英文或一串内部代号丢给用户看。
 *
 * **白名单是唯一出口，所以它必须与 stripToChinese 的删除表逐字符对齐。**
 * 早先白名单漏了「@」「*」「_」等形：删表里没有 ⇒ 残字既不被删也过不了终检 ⇒ 整篇
 * 被判空(宁缺毋滥变成全缺)，上层据此换通道重答；调用方的兜底又把它拼回去，脏符号最终
 * 仍出现在导出正文里。现在凡不在白名单里的字符一律删除，不再维护第二份符号清单。
 *
 * 结构不因此丢失：正文靠 【小节】 与「1.」编号行切段(检索、维度筛选、缺段重写都按
 * 此判断)，所以归一化会把编号翻成「一、」、把小节名重新包进 【】 独占一行；【】 是
 * 白名单里唯一放行的非汉字符号。句中括号仍按普通符号删除，不给豁免。
 * ========================================================================== */

export const FIELD_NAME_ZH: Record<string, string> = {
  patternFacts: '格局事实', strengthScore: '旺衰评分', tiaohouFacts: '调候参考', dayMaster: '日主', elementRatio: '五行比例',
  elements: '五行', hiddenStems: '藏干', tenGods: '十神', naYin: '纳音', twelveLongevity: '十二长生',
  shenSha: '神煞', relationships: '刑冲合害', solarDate: '公历日期', lunarDate: '农历日期',
  zodiac: '生肖', gender: '性别', birthYear: '出生年', pillars: '四柱', natal: '命盘事实',
  periodFacts: '时段运势', analyses: '已算批断', missing: '数据缺口', plan: '检索计划',
  verdict: '判定', favorites: '喜用', favorable: '喜用', unfavorable: '忌神', score: '分值',
};

const ZH_ONLY = /^[一-鿿 \n、。，：；？！]+$/;

/** stripToChinese 终态删除用的取反字符类(逐字符与 ZH_ONLY 对齐)。 */
const NOT_ALLOWED = /[^一-鿿\n、。，：；？！ \t【】]/g;

/** 正文是否已是「纯中文」(汉字 + 空白 + 中文句读)。这是清洗后的终检，不是清洗的一部分。
 *  小节括号 【】 是唯一的例外：它由 normalizeStructure 专门保留、承载小节结构，
 *  检索/维度筛选/缺段重写都靠它切段。除此之外任何符号都不放行。 */
export function isChineseOnly(text: string): boolean {
  const s = String(text ?? '').trim().replace(/[【】]/g, '');
  return s.length > 0 && ZH_ONLY.test(s);
}

/** 闸门拦下的原文里到底有什么违规字符 → 供日志定位(只回类型，不回内容)。 */
export function nonChineseKinds(text: string): string[] {
  const s = String(text ?? '');
  const kinds: string[] = [];
  if (/[A-Za-z]/.test(s)) kinds.push('拉丁字母');
  if (/[0-9０-９]/.test(s)) kinds.push('数字');
  if (/[（）()《》〈〉「」『』〔〕“”‘’]/.test(s)) kinds.push('括号引号');
  // 「其他符号」= 闸门白名单之外的一切：既包括半角标点，也包括 ㊣/█ 这类不在任何清洗表里的
  // 生僻符号。旧写法只列 ASCII 标点，生僻符号会被漏报成「无违规」，日志就查不出闸门为何拦下。
  // 【】 是放行的结构标记，不计入违规。
  if (/[^一-鿿 \n、。，：；？！【】]/.test(s)) kinds.push('其他符号');
  return kinds;
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 阿拉伯数字 → 中文数字。年份按逐位读(一九八四)，其余按小整数读(二十八、一百二十)。 */
function numToChinese(raw: string): string {
  const s = String(raw).replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
  if (!/^[0-9]+(?:\.0+)?$/.test(s)) return '';
  const int = Math.floor(Number(s));
  if (int >= 1000 || /\./.test(String(raw))) return [...String(int)].map((d) => CN_DIGITS[+d]).join('');
  if (int < 10) return CN_DIGITS[int];
  if (int < 20) return '十' + (int % 10 ? CN_DIGITS[int % 10] : '');
  if (int < 100) return CN_DIGITS[Math.floor(int / 10)] + '十' + (int % 10 ? CN_DIGITS[int % 10] : '');
  return CN_DIGITS[Math.floor(int / 100)] + '百' + (int % 100 === 0 ? '' : int % 100 < 10 ? '零' + CN_DIGITS[int % 100] : numToChinese(String(int % 100)));
}

/* ── 结构标记归一化：清洗必须在「认得出小节」的前提下做 ─────────────────────
 * 全文检索/复制筛选/orchestrator 的缺段重写判据，全都按正文里的 【小节】 与
 * 「1. 2.」编号行来切；提示词也硬性要求模型逐段给出这两种标记(见 deepseekAdapter.ts
 * OUTPUT_RULES_TEXT 第 2 条)。若直接删括号，「【健康】注意作息」会变成「健康注意作息」
 * 粘成一句：小节标题与正文分不开、维度筛选命中不到、缺段判据恒为「不缺」。
 * 所以这里先把结构翻成闸门认得的写法：小节名仍包在 【】 里、独占一行(【】是白名单里
 * 唯一放行的非汉字符号)，编号翻成「一、二、」，再交给 stripToChinese 去掉其它一切符号。 */
const CN_ORDINALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnOrdinal = (n: number): string => (n <= 10 ? CN_ORDINALS[n] : String(n));

/** 提示词硬性要求的小节名全集(与 deepseekAdapter/server ai.mjs/lib.rs 的逐段清单同源)。
 *  归一化只处理整行标记，这份名单本身不参与清洗，留作两端核对用。 */
const SECTION_TITLES = [
  '身强身弱与喜忌', '健康', '事业', '财运', '爱情', '刑冲克害批注', '总评/行为建议',
  '核心结论', '值得关注的时间节点', '行动建议', '后天调整', '事业适配', '健康注意',
];

/** 把 AI 正文的结构标记改写为纯中文写法：小节名仍用 【】 独占一行，编号行改「一、」「二、」。 */
function normalizeStructure(input: string): string {
  let out = String(input ?? '').replace(/\r/g, '');
  // 整行的 【小节】(可带尾随正文) → 「【干净小节名】+ 空行」，标题与正文之间留一个空行，
  // 下游分点排版正是按空行分段(PersonDetail.pointBodyText)。
  out = out.replace(/(?:^|\n)[ \t]*【([^】\n]{1,16})】[ \t]*/g, (_m, head: string) => '\n\n【' + stripToChinese(head) + '】\n\n');
  // 句中(同行还有别的字)的 【小节】 → 只清洗名字、括号原样留着：聊天里「依据…【事业】小节」
  // 这类引用式括号若硬拆成行会把句子撕开。
  out = out.replace(/【([^】\n]{1,16})】/g, (_m, head: string) => '【' + stripToChinese(head) + '】');
  // 编号行「1. / 2、/ (3)」→ 中文序号顿号式，避免数字转成「一」后又粘上后面的标点。
  out = out.replace(/(?:^|\n)[ \t(]*([0-9０-９]{1,2})[ \t]*[.。、)）][ \t]*/g, (_m, d: string) => '\n' + cnOrdinal(Number(d.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)))) + '、');
  // 归一化留下的连续空行压成一个：标题与正文之间只留一个分隔空行。
  return out.replace(/\n{3,}/g, '\n\n');
}

/** 逐条剥掉违规片段：先按已知字段名翻中文，再删括号注音、英文残句、裸标识符与符号。 */
function stripToChinese(input: string): string {
  let out = normalizeStructure(input);
  out = out.replace(/[（(]\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*[:=]\s*[A-Za-z0-9_.+-]+)?\s*[)）]/g, '');
  out = out.replace(/[A-Za-z_][A-Za-z0-9_]{1,}/g, (word) => FIELD_NAME_ZH[word] ?? word);
  out = out.replace(/[^一-鿿\n]*[:：]\s*(?:true|false|null|undefined|None)\b[^一-鿿\n]*/gi, '');
  out = out.replace(/[A-Za-z][A-Za-z0-9_]*/g, '');
  // 「助身方得分 28.8，」这类读数复述：数字转中文后就是「得分二十八点八，」那种无信息量长句，
  // 整段删掉。判据收紧为「后面直接跟标点」——「30 岁」「2027 年」后面跟着汉字，走下面的
  // 转中文分支保住句子，不会被抠成「 岁」「 年」那种断句。
  out = out.replace(/[ \t]*[0-9０-９]+(?:\.[0-9０-９]+)?[ \t]*(?=[。，、；：])/g, '');
  out = out.replace(/[0-9０-９]+(?:\.[0-9]+)?/g, (num) => numToChinese(num));
  out = out.replace(/[，.。;；!！?？]+(?=[，.。;；!！?？])/g, '');
  // 终态清洗：凡不在白名单(汉字/空白/中文句读/【】)里的字符一律删掉 —— 用 NOT_ALLOWED 而不是
  // 再手写一份符号表，保证「清洗删什么」与「终检放什么过」永远同源。
  out = out.replace(NOT_ALLOWED, '');
  // 闸门放行空格(分点序号「一 事业」要靠它)，但被删掉的英文/括号会留下悬空空格，
  // 如「旺衰评分 四十二」——只在中文与中文之间收掉，不动序号后的那一格。
  out = out.replace(/(?<=[一-鿿])[ \t]+(?=[一-鿿][，。、；：])/g, '');
  // 只收掉「行尾悬空」的空格(删括号/删序号留下的)，不动两行之间的换行，
  // 否则小节标题行会被并进下一句，结构当场丢失。
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').replace(/ +([，。、；：])/g, '$1');
  // 归一化出来的小节标题行/序号行可能因删符号而变空行，压掉，别留下「标题 + 空行 + 正文」。
  out = out.split('\n').map((line) => line.replace(/^\s+$/, '').replace(/\s+$/, '').replace(/^、+/, '')).filter((line, i, a) => line !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 清洗 + 终检：过不了闸门就返回空串，由调用方按「该通道没给出可用中文」处理。 */
export function enforceChinese(text: string): string {
  const cleaned = stripToChinese(text);
  if (!cleaned) return '';
  // 小节括号是结构标记(见 normalizeStructure)，isChineseOnly 已把它列为唯一例外。
  if (isChineseOnly(cleaned)) return cleaned;
  console.warn('[正文中文闸门] 清洗后仍不合规：' + nonChineseKinds(cleaned).join('/'));
  return '';
}

/** 聊天回答：限死纯中文，清洗不过即清空(上层据此换通道重答)。 */
export function sanitizeChatText(text: string): string {
  return enforceChinese(text);
}

/** 批断正文(explanation 等)：与聊天同一道闸门，同样不留豁免。 */
export function sanitizeAnalysisText(text: string): string {
  return enforceChinese(text);
}
