import { describe, expect, it } from 'vitest';
import { BUILD_ID, GIT_VERSION, buildLabel, cacheLabel, cnVersion, cacheReadout, versionLabel } from '../utils/buildInfo';

describe('版本信息', () => {
  it('构建号被注入：测试环境回退为 unknown，生产构建是时间戳', () => {
    // vitest 不走 vite 的生产 define，所以这里拿到的是回退值；
    // 生产由 scripts 里核对 dist 内的实际值，见部署流程。
    expect(typeof BUILD_ID).toBe('string');
    expect(BUILD_ID.length).toBeGreaterThan(0);
  });

  it('时间戳读成中文：界面正文里不留阿拉伯数字与半角符号', () => {
    const at = new Date(2026, 8, 22, 9, 5).getTime(); // 本地时区 2026-09-22 09:05
    expect(buildLabel(String(at))).toBe('二零二六年九月二十二日九时五分');
    // 一月三日零点零七分：月/日/时都该按中文数读，不是逐位读。
    expect(buildLabel(String(new Date(2026, 0, 3, 0, 7).getTime()))).toBe('二零二六年一月三日零时七分');
  });

  it('非时间戳的构建号原样返回，不抛错也不显示 Invalid Date', () => {
    expect(buildLabel('unknown')).toBe('unknown');
    expect(buildLabel('')).toBe('');
    expect(buildLabel('abc')).toBe('abc');
  });

  it('缓存号与 SW 里的命名一致(mingli-<构建号>)', () => {
    expect(cacheLabel('1234567890')).toBe('mingli-1234567890');
    expect(cacheLabel()).toBe('mingli-' + BUILD_ID);
  });

  it('有 git 号时版本标签用它(能对上快照名)，没有则退回构建时间', () => {
    // vitest 不走生产 define，所以 GIT_VERSION 这里为空串 → 应退回 buildLabel。
    expect(typeof GIT_VERSION).toBe('string');
    expect(versionLabel()).toBe(GIT_VERSION ? cnVersion(GIT_VERSION) : buildLabel());
  });

  /* 「版本号 6-caa86bd」是机器标识：直接印在正文里就等于界面出现拉丁字母与数字。
     读法要保住两类信息 —— 提交序号(第几版，可照着回退)与哈希逐位(哈希无读音，只能念)。 */
  it('git 版本号读成中文：序号按中文数读、哈希逐位念，形状相近的字母不混', () => {
    expect(cnVersion('6-caa86bd')).toBe('第六版，校验码西阿阿八六比地');
    expect(cnVersion('21-9f3')).toBe('第二十一版，校验码九弗三');
    expect(cnVersion('107-ab12')).toBe('第一零七版，校验码阿比一二');
    // 认不出「序号-哈希」形态的原样返回，绝不编一个读法出来
    expect(cnVersion('unknown')).toBe('unknown');
    expect(cnVersion('')).toBe('');
    // 读出来的串不许带拉丁字母与数字
    for (const raw of ['6-caa86bd', '21-9f3']) expect(cnVersion(raw)).not.toMatch(/[A-Za-z0-9]/);
  });

  it('已缓存版本只报状态，机器号留给 title', () => {
    expect(cacheReadout('mingli-1770000000000', 'mingli-1770000000000')).toBe('与本页面同一版缓存');
    expect(cacheReadout('mingli-1760000000000', 'mingli-1770000000000')).toContain('那次构建的缓存');
    expect(cacheReadout('mingli-1760000000000', 'mingli-1770000000000')).not.toMatch(/[A-Za-z0-9]/);
    expect(cacheReadout('检测中')).toBe('检测中');
    expect(cacheReadout('此环境不支持')).toBe('此环境不支持');
    expect(cacheReadout('')).toBe('暂无');
    // 拿不到形如 mingli-<时间戳> 的串也不能把原文吐回界面
    expect(cacheReadout('weird-value')).toBe('另一版缓存');
  });
});
