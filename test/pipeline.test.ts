import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPipeline } from '../src/core/pipeline';
import type { StepDef } from '../src/core/steps';
import type { StepId, StepStatus } from '../src/core/types';
import { sampleContext } from './helpers';

/** 実行履歴を記録する fake step。段階 1 が 2 つ、段階 2 が 1 つ。 */
function fakes(status: Record<string, StepStatus>, ran: string[]): StepDef[] {
  const mk = (id: StepId, stage: 1 | 2): StepDef => ({
    id,
    label: id,
    stage,
    prerequisite: () => (status[id] === 'skip' ? { reason: 'テスト用 skip', hint: '対処案' } : undefined),
    async run() {
      ran.push(id);
      return { status: status[id] ?? 'pass', diags: [], log: '', reason: status[id] === 'fail' ? '失敗' : undefined };
    },
  });
  return [mk('norminette', 1), mk('warnings', 1), mk('asanUbsan', 2)];
}

const ALL: StepId[] = ['norminette', 'warnings', 'asanUbsan'];

test('段階 1 が失敗したら、段階 1 の残りは実行し、段階 2 は一切実行しない', async () => {
  const { ctx, cleanup } = sampleContext('ok');
  const ran: string[] = [];
  const r = await runPipeline(ctx, { selected: ALL, steps: fakes({ norminette: 'fail' }, ran) });
  assert.deepEqual(ran, ['norminette', 'warnings']);
  assert.equal(r.ok, false);
  assert.deepEqual([r.stoppedAt?.stage, r.stoppedAt?.id], [1, 'norminette']);
  assert.deepEqual(r.notRun.map((n) => n.id), ['asanUbsan']);
  cleanup();
});

test("failFast: 'step' では最初の失敗で止める", async () => {
  const { ctx, cleanup } = sampleContext('ok', { failFast: 'step' });
  const ran: string[] = [];
  const r = await runPipeline(ctx, { selected: ALL, steps: fakes({ norminette: 'fail' }, ran) });
  assert.deepEqual(ran, ['norminette']);
  assert.deepEqual(r.notRun.map((n) => n.id), ['warnings', 'asanUbsan']);
  cleanup();
});

test('skip は失敗ではない: 後続の段階へ進み、結果に skip が残る', async () => {
  const { ctx, cleanup } = sampleContext('ok');
  const ran: string[] = [];
  const r = await runPipeline(ctx, { selected: ALL, steps: fakes({ norminette: 'skip' }, ran) });
  assert.equal(r.ok, true);
  assert.deepEqual(ran, ['warnings', 'asanUbsan']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].hint, '対処案');
  cleanup();
});

test('チェックされていない項目は実行しない', async () => {
  const { ctx, cleanup } = sampleContext('ok');
  const ran: string[] = [];
  await runPipeline(ctx, { selected: ['asanUbsan'], steps: fakes({}, ran) });
  assert.deepEqual(ran, ['asanUbsan']);
  cleanup();
});

test('段階 0 が失敗 (空き容量不足) なら、何も実行しない', async () => {
  const { ctx, cleanup } = sampleContext('ok', { minFreeSpaceMB: Number.MAX_SAFE_INTEGER });
  const ran: string[] = [];
  const r = await runPipeline(ctx, { selected: ALL, steps: fakes({}, ran) });
  assert.equal(ran.length, 0);
  assert.equal(r.stoppedAt?.id, 'prepare');
  assert.match(r.stoppedAt?.reason ?? '', /空き容量/);
  cleanup();
});

test('.42check/ が上限を超えたら中断する', async () => {
  const { ctx, cleanup } = sampleContext('ok', { workDirMaxMB: 1 });
  const ran: string[] = [];
  const steps = fakes({}, ran);
  steps[0] = {
    ...steps[0],
    async run() {
      ran.push('norminette');
      (await import('node:fs')).writeFileSync(`${ctx.workDir}/big.bin`, Buffer.alloc(2 * 1024 * 1024));
      return { status: 'pass', diags: [], log: '' };
    },
  };
  const r = await runPipeline(ctx, { selected: ALL, steps });
  assert.deepEqual(ran, ['norminette'], '上限超過後の項目は実行しない');
  assert.match(r.stoppedAt?.reason ?? '', /上限/);
  cleanup();
});
