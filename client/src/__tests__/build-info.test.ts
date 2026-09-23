import { describe, expect, it } from 'vitest';
import { BUILD_ID, GIT_VERSION, buildLabel, cacheLabel, versionLabel } from '../utils/buildInfo';

describe('版本信息', () => {
  it('构建号被注入：测试环境回退为 unknown，生产构建是时间戳', () => {
    // vitest 不走 vite 的生产 define，所以这里拿到的是回退值；
    // 生产由 scripts 里核对 dist 内的实际值，见部署流程。
    expect(typeof BUILD_ID).toBe('string');
    expect(BUILD_ID.length).toBeGreaterThan(0);
  });

  it('时间戳格式化为「月-日 时:分」，便于比新旧', () => {
    const at = new Date(2026, 8, 22, 9, 5).getTime(); // 本地时区 2026-09-22 09:05
    expect(buildLabel(String(at))).toBe('09-22 09:05');
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
    expect(versionLabel()).toBe(GIT_VERSION || buildLabel());
  });
});
