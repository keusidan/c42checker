import * as vscode from 'vscode';
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
