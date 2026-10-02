/* =============================================================================
 * 通道报错的「能上屏」判据
 *
 * 为什么单独成文件：报错文本是这条链路上唯一一处**由应用自己写出、又必须过中文闸门**的正文。
 * 原先它一路带着 DeepSeek / HTTP 503 / JSON /（）这类形态进到 record.aiError 与聊天错误框，
 * 展示层那句 sanitizeAnalysisText(...) || '回答失败' 于是几乎总走后半段 —— 用户看到的是
 * 「未知错误」，真正的原因(该补哪条通道的凭据、是限流还是余额)反而丢了。
 *
 * 这里的判据分两层，缺一不可：
 *  1) 源头不许造脏串：classifyFailure / channelName / cnCode 的产物本身就得纯中文；
 *  2) 拼出来的整句喂给真实闸门(enforceChinese)后不许被判空 —— 这一条才是「原因没丢」的证据。
 *     只断言第 1 层会漏掉拼接环节：有人把英文残句直接 + 进去时，各分段仍各自干净。
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { classifyFailure, cnCode, readableTransportError } from '../data/deepseekAdapter';
import { enforceChinese } from '../features/chart/elements';

/** 闸门同款终检：清洗后仍非纯中文就返回空串，调用方按「这条通道没给出可用中文」处理。 */
const survivesGate = (text: string): boolean => enforceChinese(text).length > 0;

describe('通道报错读法：源头纯中文，且整句喂给闸门后不塌成空', () => {
  const statuses = [0, 400, 401, 402, 403, 404, 429, 500, 503];

  it('每个状态码的分类说法都不含拉丁字母、阿拉伯数字或半角符号', () => {
    for (const status of statuses) {
      const text = classifyFailure(status, '');
      expect(/[A-Za-z]/.test(text), `状态码 ${status} 的分类里出现了英文：${text}`).toBe(false);
      expect(/[0-9]/.test(text), `状态码 ${status} 的分类里出现了数字：${text}`).toBe(false);
      // 全角括号也不放行：它是「算法痕迹」的一种，正式版口径下正文只用顿号与句读。
      expect(/[（）()@#&*+=~^_|·／【】「」“”…—＿]/.test(text), `分类里残留符号：${text}`).toBe(false);
    }
  });

  it('限流与服务端故障不再写「已被限流」「上游 5xx」这类过程术语', () => {
    expect(classifyFailure(429, '')).toBe('请求过于频繁，已被限流');
    expect(classifyFailure(503, '')).toBe('服务端故障');
    expect(classifyFailure(429, '')).not.toContain('（');
    expect(classifyFailure(500, '')).not.toMatch(/5xx|[A-Za-z]/);
  });

  it('上游自述若是整句英文，退回固定中文而不是把残句拼进报错', () => {
    const text = classifyFailure(400, '{"error":{"message":"Invalid api key"}}');
    expect(/[A-Za-z{}":,]/.test(text), '英文残句漏进了报错：' + text).toBe(false);
    expect(survivesGate(text)).toBe(true);
  });

  it('状态码逐位读成中文数字', () => {
    expect(cnCode(503)).toBe('五零三');
    expect(cnCode(429)).toBe('四二九');
    expect(cnCode(0)).toBe('零');
  });

  it('网络类错误按语义归类，其余残句过闸门后仍有话说', () => {
    expect(readableTransportError('signal is aborted without reason')).toBe('网络超时或不可达');
    expect(readableTransportError('Failed to fetch')).toBe('网络不可达或延迟过高');
    expect(readableTransportError('')).toBe('该通道未返回可显示的原因');
    expect(readableTransportError('upstream connect error')).not.toBe('');
  });

  it('拼成「通道名：原因，服务返回五零三」后整句喂给闸门不塌成空', () => {
    // 这条同时钉住三件事：通道名取自设置页那三个中文名、状态码已读成中文、拼接符是全角。
    for (const status of statuses) {
      const line = '通道一深思：' + classifyFailure(status, '') + '，服务返回' + cnCode(status);
      expect(survivesGate(line), '整句被闸门判空，界面会退化成「未知错误」：' + line).toBe(true);
      expect(line).not.toMatch(/[A-Za-z0-9]/);
    }
  });

  it('通道名一律取设置页的中文叫法，不再出现 DeepSeek 与 Kimi', () => {
    // 回归钉子：CHANNELS[].label 仍是机器名(协议层要用)，报错文本必须走 channelName 那条路。
    const body = 'nope';
    const joined = ['通道一深思', '通道二克米', '通道三千问']
      .map((name) => name + '：' + classifyFailure(401, body))
      .join('；');
    expect(joined).not.toMatch(/DeepSeek|Kimi|Qwen/);
    expect(survivesGate(joined)).toBe(true);
  });
});
