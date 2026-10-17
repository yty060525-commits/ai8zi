import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Server JavaScript has no declaration file; Vitest executes this shared contract directly.
import { birthTimeSignature } from '../../../server/ai.mjs';

const invoke = vi.fn(async () => ({ status: 'completed', answer: '答案' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../data/clientRepository', () => ({ listBaziRecords: vi.fn(async () => []), hydrateRecord: vi.fn(async (r) => r), unsyncedRecordIds: vi.fn(async () => []) }));
vi.mock('../data/serverClient', () => ({ isServerMode: () => false, serverFetch: vi.fn(), ServerError: class ServerError extends Error {} }));
vi.mock('../data/deepseekAdapter', () => ({ chatDirect: vi.fn(), toneInstructionText: vi.fn(() => '') }));
vi.mock('../data/aiSettings', () => ({ getBrowserCredential: vi.fn() }));

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const record = {
  id: 'cache-chart', name: '张三', gender: 'male', birthYear: 1984, birthMonth: 2,
  yearPillar: '甲子', monthPillar: '丙寅', dayPillar: '庚午', hourPillar: '壬午',
  createdAt: '2026-01-01', aiStatus: 'not_started',
  nonAiResult: { birthTime: { year: 1984, month: 2, day: 3, hour: 9, minute: 10 }, dayMaster: '庚', elements: {}, tenGods: [], hiddenStems: [], relationships: {} },
};

afterEach(() => { invoke.mockClear(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('出生时刻缓存跨端契约', () => {
  it('JS 缓存签名与 Rust 元数据规范相同，并在任务与聊天键末尾保留空旧签名', () => {
    const ai = src('../../../server/ai.mjs'), chat = src('../../../server/chat.mjs'), rust = src('../../src-tauri/src/lib.rs');
    expect(ai).toContain('birthTimeSignature');
    expect(chat).toContain('birthTimeSignature');
    expect(rust).toContain('fn birth_time_signature');
    expect(rust).toContain('birthTime');
    expect(birthTimeSignature({ year: 1984, month: 2, day: 3, hour: 9, minute: 10 })).toBe('1984-02-03T09:10');
    expect(birthTimeSignature({ year: 1984, month: 2, day: 3, hour: 9, minute: 11 })).not.toBe('1984-02-03T09:10');
    expect(birthTimeSignature({ year: 1984, month: 2, day: 30, hour: 9, minute: 10 })).toBe('');
  });

  it('真实 Tauri run_ai_chat invoke 收到命盘里的 birthTime 缓存元数据', async () => {
    const { listBaziRecords } = await import('../data/clientRepository');
    vi.mocked(listBaziRecords).mockResolvedValue([record] as never);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { askChat } = await import('../data/chatEngine');
    await askChat({ question: '事业如何？' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = invoke.mock.calls[0] as unknown as [string, { chat: Record<string, unknown> }];
    expect(command).toBe('run_ai_chat');
    expect(payload.chat.birthTime).toEqual(record.nonAiResult.birthTime);
  });
});
