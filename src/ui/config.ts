import * as vscode from 'vscode';
import { TOGGLES, type ToggleDef } from '../core/toggles';
import {
  DEFAULT_CHECKS,
  DEFAULT_SETTINGS,
  STEP_IDS,
  type CompdbSource,
  type FailFast,
  type Settings,
  type StepId,
} from '../core/types';

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('c42check');
}

/** 文字列の配列として読む。型が違う (設定の書き間違い) ときは既定値に戻す。 */
function strings(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;
}

function perStep(v: unknown): Partial<Record<StepId, string[]>> {
  const out: Partial<Record<StepId, string[]>> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const id of STEP_IDS) {
    const list = (v as Record<string, unknown>)[id];
    if (Array.isArray(list) && list.every((x) => typeof x === 'string')) out[id] = list as string[];
  }
  return out;
}

export function readChecks(): Record<StepId, boolean> {
  const raw = cfg().get<Record<string, boolean>>('checks') ?? {};
  const checks = { ...DEFAULT_CHECKS };
  for (const id of STEP_IDS) if (typeof raw[id] === 'boolean') checks[id] = raw[id];
  return checks;
}

export function readSettings(): Settings {
  const c = cfg();
  const d = DEFAULT_SETTINGS;
  return {
    targetDir: c.get<string>('targetDir') ?? d.targetDir,
    includePaths: c.get<string[]>('includePaths') ?? d.includePaths,
    runArgs: c.get<string[]>('runArgs') ?? d.runArgs,
    useMakeCheckTarget: c.get<boolean>('useMakeCheckTarget') ?? d.useMakeCheckTarget,
    failFast: (c.get<string>('failFast') as FailFast | undefined) ?? d.failFast,
    minFreeSpaceMB: c.get<number>('minFreeSpaceMB') ?? d.minFreeSpaceMB,
    workDirMaxMB: c.get<number>('workDirMaxMB') ?? d.workDirMaxMB,
    runTimeoutSec: c.get<number>('runTimeoutSec') ?? d.runTimeoutSec,
    staticTimeoutSec: c.get<number>('staticTimeoutSec') ?? d.staticTimeoutSec,
    mainFile: c.get<string>('mainFile') ?? d.mainFile,
    compdbIncludeMain: c.get<boolean>('compdb.includeMain') ?? d.compdbIncludeMain,
    compdbSource: (c.get<string>('compdb.source') as CompdbSource | undefined) ?? d.compdbSource,
    debugSanitizer: c.get<boolean>('debug.sanitizer') ?? d.debugSanitizer,
    protoHeader: c.get<string>('proto.header') ?? d.protoHeader,
    protoSourceDir: c.get<string>('proto.sourceDir') ?? d.protoSourceDir,
    protoSyncOnRun: c.get<boolean>('proto.syncOnRun') ?? d.protoSyncOnRun,
    protoSyncOnSave: c.get<boolean>('proto.syncOnSave') ?? d.protoSyncOnSave,
    normExclude: strings(c.get<unknown>('normExclude'), d.normExclude),
    compileCflags: strings(c.get<unknown>('compile.cflags'), d.compileCflags),
    compileLdflags: strings(c.get<unknown>('compile.ldflags'), d.compileLdflags),
    compileLibs: strings(c.get<unknown>('compile.libs'), d.compileLibs),
    compileWarningFlags: strings(c.get<unknown>('compile.warningFlags'), d.compileWarningFlags),
    compilePerStep: perStep(c.get<unknown>('compile.perStep')),
    clangTidyChecks: c.get<string>('clangTidy.checks') ?? d.clangTidyChecks,
    valgrindArgs: strings(c.get<unknown>('valgrind.args'), d.valgrindArgs),
    checks: readChecks(),
  };
}

/** チェック状態をワークスペース設定 (.vscode/settings.json) に保存する。 */
export async function writeCheck(id: StepId, value: boolean): Promise<void> {
  const next = { ...readChecks(), [id]: value };
  await cfg().update('checks', next, vscode.ConfigurationTarget.Workspace);
}

export function selectedSteps(): StepId[] {
  const checks = readChecks();
  return STEP_IDS.filter((id) => checks[id]);
}

export function debugLaunchOptions(): { cwd: string; terminal: string } {
  const c = cfg();
  return {
    cwd: c.get<string>('debug.cwd') ?? '${workspaceFolder}',
    terminal: c.get<string>('debug.terminal') ?? 'integrated',
  };
}

/** 「設定」グループのチェック状態 = settings.json の対応キーの現在値。 */
export function readToggle(def: ToggleDef): boolean {
  const v = cfg().get<unknown>(def.key);
  return v === undefined ? def.defaultValue : def.fromConfig(v);
}

/** チェックの変更を、ワークスペースの settings.json の対応キーに書く。 */
export async function writeToggle(def: ToggleDef, checked: boolean): Promise<void> {
  await cfg().update(def.key, def.toConfig(checked), vscode.ConfigurationTarget.Workspace);
}

export function toggleById(id: string): ToggleDef | undefined {
  return TOGGLES.find((t) => t.id === id);
}

/** エディタで開かれていて、未保存の変更がある (ディスク上のファイルを書き換えてはいけない) か。 */
export function isFileDirty(absPath: string): boolean {
  return vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === absPath);
}
