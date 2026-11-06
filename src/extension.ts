import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ensureGenerated, STATE_DIR } from './core/compdb';
import { createContext } from './core/context';
import { applyMigration, describePlan, isEmptyPlan, planMigration } from './core/migrate';
import { shellQuoteArgs } from './core/launchConfig';
import { STEPS } from './core/steps';
import { STEP_IDS, type StepId } from './core/types';
import { dirSize, resetWorkDir } from './core/workdir';
import { isFileDirty, readSettings, workspaceRoot } from './ui/config';
import { Problems } from './ui/diagnostics';
import { checkEnvironment } from './ui/envCheck';
import { generateDebugConfig, proposeAbortOnTaskErrors, suggestAbortIfNeeded } from './ui/launchGen';
import { Outputs } from './ui/output';
import { PROPOSAL_SCHEME, ProtoSync } from './ui/protoCommand';
import { Runner } from './ui/runner';
import { CheckTaskProvider } from './ui/taskProvider';
import { CheckTree } from './ui/tree';

/** 「この項目だけ実行」の引数 (ツリーの項目 / 項目の id) から、項目の id を取り出す。 */
function stepIdOf(arg: unknown): StepId | undefined {
  const id = typeof arg === 'string' ? arg : (arg as { kind?: string; id?: string } | undefined)?.kind === 'step' ? (arg as { id: string }).id : undefined;
  return STEP_IDS.find((s) => s === id);
}

async function pickStep(): Promise<StepId | undefined> {
  const pick = await vscode.window.showQuickPick(
    STEPS.map((s) => ({ label: s.label, description: `段階 ${s.stage}`, detail: s.note, id: s.id })),
    { title: '実行する項目を選んでください (チェックの状態に関係なく、この項目だけ実行します)', matchOnDetail: true },
  );
  return pick?.id;
}

const MIGRATION_DECLINED = 'c42checker.migrationDeclined';

/**
 * 改名前 (c42check / .42check) の設定・task・launch・.gitignore・作業ディレクトリを、c42checker の名前に書き換える。
 * 書き換える内容を示して、承認を取ってから行う。interactive が false (起動時の案内) のときは、見つからなくても何も言わない。
 */
export async function migrateFromOldName(runner: Runner, outputs: Outputs, interactive = true): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    if (interactive) void vscode.window.showErrorMessage('c42checker: フォルダを開いてから実行してください。');
    return;
  }
  if (runner.isRunning) {
    void vscode.window.showWarningMessage('c42checker: 検証の実行中は書き換えられません。終わってからもう一度実行してください。');
    return;
  }
  const plan = planMigration(root);
  if (isEmptyPlan(plan)) {
    if (interactive) void vscode.window.showInformationMessage('c42checker: 旧名称 (c42check / .42check) のものは見つかりませんでした。');
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `旧名称 (c42check) を c42checker に書き換えます。\n\n${describePlan(root, plan).map((l) => `・${l}`).join('\n')}`,
    { modal: true },
    '書き換える',
  );
  if (pick !== '書き換える') return;
  const result = applyMigration(root, plan, isFileDirty);
  const out = outputs.get('移行');
  out.appendLine(result.lines.join('\n'));
  if (result.skipped.length > 0) {
    void vscode.window.showWarningMessage(`c42checker: 未保存の変更があるため、${result.skipped.length} 件を書き換えませんでした。保存してからもう一度実行してください。`, 'ログを表示').then((p) => p && out.show(true));
  } else {
    void vscode.window.showInformationMessage(`c42checker: 書き換えました (${result.lines.length} 件)。`, 'ログを表示').then((p) => p && out.show(true));
  }
}

/** 起動時: 旧名称のものが見つかったら、1 度だけ案内する (「今後は表示しない」で止められる)。 */
export async function suggestMigration(state: vscode.Memento, run: () => Promise<void>): Promise<void> {
  const root = workspaceRoot();
  if (!root || state.get<boolean>(MIGRATION_DECLINED)) return;
  if (isEmptyPlan(planMigration(root))) return;
  const migrate = '書き換える';
  const never = '今後は表示しない';
  const pick = await vscode.window.showInformationMessage(
    'c42checker: 旧名称 (c42check) の設定または作業ディレクトリ (.42check) が見つかりました。新しい名称に書き換えますか?',
    migrate,
    never,
  );
  if (pick === migrate) await run();
  else if (pick === never) await state.update(MIGRATION_DECLINED, true);
}

export function activate(context: vscode.ExtensionContext): void {
  const outputs = new Outputs();
  const problems = new Problems();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.text = '$(checklist) c42checker';
  statusBar.tooltip = 'チェック済みの検証項目を段階順に実行 (fail-fast)';
  statusBar.command = 'c42checker.run';
  statusBar.show();

  const runner = new Runner(outputs, problems, statusBar);
  const tree = new CheckTree(runner);
  const proto = new ProtoSync(outputs, problems, runner);
  const treeView = vscode.window.createTreeView('c42checker.view', { treeDataProvider: tree });

  const reg = vscode.commands.registerCommand;
  context.subscriptions.push(
    outputs,
    problems,
    statusBar,
    runner,
    tree,
    proto,
    treeView,
    treeView.onDidChangeCheckboxState((e) => void tree.onCheckbox(e.items)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('c42checker')) tree.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => proto.onSaved(doc)),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proto.provider),
    vscode.tasks.registerTaskProvider(CheckTaskProvider.type, new CheckTaskProvider(runner)),

    reg('c42checker.run', () => runner.run('check')),
    reg('c42checker.runStep', async (arg?: unknown) => {
      const id = stepIdOf(arg) ?? (await pickStep());
      if (id) await runner.run('check', undefined, [id]);
    }),
    reg('c42checker.migrateFromOldName', () => migrateFromOldName(runner, outputs)),
    reg('c42checker.cancel', () => runner.cancel()),
    reg('c42checker.refresh', () => tree.refresh()),
    reg('c42checker.syncPrototypes', () => proto.runCommand()),
    reg('c42checker.selectProtoHeader', () => proto.selectHeader()),
    reg('c42checker.applyProposal', () => proto.applyProposal()),
    reg('c42checker.cancelProposal', () => proto.cancelProposal()),
    reg('c42checker.showLog', (name?: string) => outputs.get(typeof name === 'string' ? name : 'main').show(true)),
    reg('c42checker.runArgs', () => shellQuoteArgs(readSettings().runArgs)),
    reg('c42checker.generateDebugConfig', () => generateDebugConfig()),
    reg('c42checker.proposeAbortOnTaskErrors', () => proposeAbortOnTaskErrors(true)),
    reg('c42checker.regenerateCompdb', async () => {
      const root = workspaceRoot();
      if (!root) return;
      const ctx = createContext({ root, settings: readSettings(), io: { log: () => undefined } });
      try {
        fs.mkdirSync(ctx.workDir, { recursive: true });
        const g = await ensureGenerated(ctx, { force: true });
        const r = g.compdb.result!;
        void vscode.window.showInformationMessage(
          `c42checker: compile_commands.json を再生成しました (${r.method}, ${r.entries} 件)。${g.clangd.action === 'generated' ? '.clangd も更新しました。' : (g.clangd.reason ?? '')}${r.note ? ` ${r.note}` : ''}`,
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`c42checker: 再生成に失敗しました: ${String(e)}`);
      }
    }),
    reg('c42checker.cleanWorkDir', () => {
      const root = workspaceRoot();
      if (!root) return;
      const ctx = createContext({ root, settings: readSettings(), io: { log: () => undefined } });
      const mb = Math.ceil(dirSize(ctx.workDir) / (1024 * 1024));
      resetWorkDir(ctx.workDir, [STATE_DIR]); // 生成済みの記録 (state/) は残す (消すと、compile_commands.json を自分のものと見分けられなくなる)
      void vscode.window.showInformationMessage(`c42checker: .c42checker/ を削除しました (約 ${mb}MB)。`);
    }),
  );

  void suggestMigration(context.workspaceState, async () => {
    await migrateFromOldName(runner, outputs, false);
    tree.refresh();
  });
  void checkEnvironment(context.workspaceState);
  void suggestAbortIfNeeded(context.workspaceState);
}

export function deactivate(): void {
  /* subscriptions で後始末する */
}
