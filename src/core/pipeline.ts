import * as path from 'node:path';
import { buildBinary, buildInputs, debugFlags, NO_MAIN_HINT, NO_MAIN_REASON } from './build';
import { prepare } from './prepare';
import { STEPS, type StepDef } from './steps';
import type { Context, StepId, StepOutcome, StepResult } from './types';
import { dirSize } from './workdir';

export interface PipelineHooks {
  onStage?(stage: number, label: string): void;
  onStepStart?(id: StepResult['id'], label: string): void;
  onStepEnd?(result: StepResult): void;
}

export interface PipelineRequest {
  /** チェック済みの項目 */
  selected: StepId[];
  /** true なら、全段階通過後にデバッグ用ビルドまで行う (F5 の preLaunchTask 用) */
  debugBuild?: boolean;
  /** true なら、段階 1・2 を飛ばしてデバッグ用ビルドだけ行う ("Debug (skip checks)" 用) */
  debugBuildOnly?: boolean;
  /** テスト用: ステップ定義の差し替え */
  steps?: StepDef[];
}

export interface PipelineReport {
  ok: boolean;
  results: StepResult[];
  /** 最初に失敗した箇所 */
  stoppedAt?: { stage: number; id: StepResult['id']; label: string; reason?: string };
  /** 失敗により実行しなかった、選択済みの項目 */
  notRun: { id: StepId; label: string }[];
  skipped: StepResult[];
}

const MB = 1024 * 1024;

function toResult(
  id: StepResult['id'],
  label: string,
  stage: number,
  out: StepOutcome,
  ms: number,
): StepResult {
  return { id, label, stage, ms, ...out };
}

export async function runStep(ctx: Context, step: StepDef): Promise<StepResult> {
  const t0 = Date.now();
  const skip = step.prerequisite(ctx);
  if (skip) {
    return toResult(step.id, step.label, step.stage, { status: 'skip', diags: [], log: '', ...skip }, 0);
  }
  try {
    return toResult(step.id, step.label, step.stage, await step.run(ctx), Date.now() - t0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return toResult(step.id, step.label, step.stage, { status: 'fail', diags: [], log: `${msg}\n`, reason: `内部エラー: ${msg}` }, Date.now() - t0);
  }
}

/** デバッグ用ビルド (.42check/debug/prog)。段階 3 の直前に行う。 */
export async function buildDebug(ctx: Context): Promise<StepResult> {
  const t0 = Date.now();
  const label = 'デバッグ用ビルド';
  if (!buildInputs(ctx).usable) {
    return toResult('debug-build', label, 3, { status: 'fail', diags: [], log: '', reason: NO_MAIN_REASON, hint: NO_MAIN_HINT }, 0);
  }
  const b = await buildBinary(ctx, path.join(ctx.workDir, 'debug'), debugFlags(ctx), 'clang');
  return toResult(
    'debug-build',
    label,
    3,
    { status: b.ok ? 'pass' : 'fail', diags: b.diags, log: b.output, reason: b.ok ? undefined : 'デバッグ用ビルドに失敗しました' },
    Date.now() - t0,
  );
}

/**
 * 段階 0 → 段階 1 → 段階 2 (→ デバッグ用ビルド) を実行する。
 * 前の段階が 1 つでも fail したら、後続の段階は一切実行しない (skip は fail ではない)。
 * failFast = 'step' のときは、最初の fail で即座に止める。
 */
export async function runPipeline(ctx: Context, req: PipelineRequest, hooks: PipelineHooks = {}): Promise<PipelineReport> {
  const steps = req.steps ?? STEPS;
  const results: StepResult[] = [];
  const selected = steps.filter((s) => req.selected.includes(s.id));
  let stopped: PipelineReport['stoppedAt'];

  const record = (r: StepResult) => {
    results.push(r);
    hooks.onStepEnd?.(r);
    if (r.status === 'fail' && !stopped) {
      stopped = { stage: r.stage, id: r.id, label: r.label, reason: r.reason };
    }
  };
  const finish = (): PipelineReport => ({
    ok: !stopped,
    results,
    stoppedAt: stopped,
    notRun: selected
      .filter((s) => !results.some((r) => r.id === s.id))
      .map((s) => ({ id: s.id, label: s.label })),
    skipped: results.filter((r) => r.status === 'skip'),
  });

  // 段階 0
  hooks.onStage?.(0, '準備');
  hooks.onStepStart?.('prepare', '準備');
  const t0 = Date.now();
  record(toResult('prepare', '準備', 0, await prepare(ctx), Date.now() - t0));
  if (stopped) return finish();

  const maxBytes = ctx.settings.workDirMaxMB * MB;
  const overLimit = (stage: number): StepResult | undefined => {
    const size = dirSize(ctx.workDir);
    if (size <= maxBytes) return undefined;
    return toResult(
      'prepare',
      '.42check/ の容量',
      stage,
      {
        status: 'fail',
        diags: [],
        log: `.42check/ が ${Math.ceil(size / MB)}MB で、上限 ${ctx.settings.workDirMaxMB}MB を超えました\n`,
        reason: `.42check/ が上限 ${ctx.settings.workDirMaxMB}MB を超えました (${Math.ceil(size / MB)}MB)`,
        hint: '設定 `c42check.workDirMaxMB` を見直すか、巨大なビルド成果物が出ていないか確認してください',
      },
      0,
    );
  };

  if (!req.debugBuildOnly) {
    for (const stage of [1, 2] as const) {
      const stageSteps = selected.filter((s) => s.stage === stage);
      if (stageSteps.length === 0) continue;
      hooks.onStage?.(stage, `段階 ${stage}`);
      for (const step of stageSteps) {
        if (ctx.signal?.aborted) {
          record(toResult(step.id, step.label, stage, { status: 'fail', diags: [], log: '', reason: '中止されました' }, 0));
          return finish();
        }
        hooks.onStepStart?.(step.id, step.label);
        record(await runStep(ctx, step));
        const over = overLimit(stage);
        if (over) {
          record(over);
          return finish();
        }
        if (stopped && ctx.settings.failFast === 'step') return finish();
      }
      // 同じ段階の全項目を実行した後に、失敗があれば後続の段階へ進まない
      if (stopped) return finish();
    }
  }

  if (req.debugBuild || req.debugBuildOnly) {
    hooks.onStage?.(3, 'デバッグ用ビルド');
    hooks.onStepStart?.('debug-build', 'デバッグ用ビルド');
    record(await buildDebug(ctx));
    const over = overLimit(3);
    if (over) record(over);
  }
  return finish();
}
