import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ensureGenerated, STATE_DIR } from './core/compdb';
import { createContext } from './core/context';
import { shellQuoteArgs } from './core/launchConfig';
import { STEPS } from './core/steps';
import { STEP_IDS, type StepId } from './core/types';
import { dirSize, resetWorkDir } from './core/workdir';
import { readSettings, workspaceRoot } from './ui/config';
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

export function activate(context: vscode.ExtensionContext): void {
  const outputs = new Outputs();
  const problems = new Problems();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.text = '$(checklist) 42 Check';
  statusBar.tooltip = 'チェック済みの検証項目を段階順に実行 (fail-fast)';
  statusBar.command = 'c42check.run';
  statusBar.show();

  const runner = new Runner(outputs, problems, statusBar);
  const tree = new CheckTree(runner);
  const proto = new ProtoSync(outputs, problems, runner);
  const treeView = vscode.window.createTreeView('c42check.view', { treeDataProvider: tree });

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
      if (e.affectsConfiguration('c42check')) tree.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => proto.onSaved(doc)),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proto.provider),
    vscode.tasks.registerTaskProvider(CheckTaskProvider.type, new CheckTaskProvider(runner)),

    reg('c42check.run', () => runner.run('check')),
    reg('c42check.runStep', async (arg?: unknown) => {
      const id = stepIdOf(arg) ?? (await pickStep());
      if (id) await runner.run('check', undefined, [id]);
    }),
    reg('c42check.cancel', () => runner.cancel()),
    reg('c42check.refresh', () => tree.refresh()),
    reg('c42check.syncPrototypes', () => proto.runCommand()),
    reg('c42check.applyProposal', () => proto.applyProposal()),
    reg('c42check.cancelProposal', () => proto.cancelProposal()),
    reg('c42check.showLog', (name?: string) => outputs.get(typeof name === 'string' ? name : 'main').show(true)),
    reg('c42check.runArgs', () => shellQuoteArgs(readSettings().runArgs)),
    reg('c42check.generateDebugConfig', () => generateDebugConfig()),
    reg('c42check.proposeAbortOnTaskErrors', () => proposeAbortOnTaskErrors(true)),
    reg('c42check.regenerateCompdb', async () => {
      const root = workspaceRoot();
      if (!root) return;
      const ctx = createContext({ root, settings: readSettings(), io: { log: () => undefined } });
      try {
        fs.mkdirSync(ctx.workDir, { recursive: true });
        const g = await ensureGenerated(ctx, { force: true });
        const r = g.compdb.result!;
        void vscode.window.showInformationMessage(
          `42 Check: compile_commands.json を再生成しました (${r.method}, ${r.entries} 件)。${g.clangd.action === 'generated' ? '.clangd も更新しました。' : (g.clangd.reason ?? '')}${r.note ? ` ${r.note}` : ''}`,
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`42 Check: 再生成に失敗しました: ${String(e)}`);
      }
    }),
    reg('c42check.cleanWorkDir', () => {
      const root = workspaceRoot();
      if (!root) return;
      const ctx = createContext({ root, settings: readSettings(), io: { log: () => undefined } });
      const mb = Math.ceil(dirSize(ctx.workDir) / (1024 * 1024));
      resetWorkDir(ctx.workDir, [STATE_DIR]); // 生成済みの記録 (state/) は残す (消すと、compile_commands.json を自分のものと見分けられなくなる)
      void vscode.window.showInformationMessage(`42 Check: .42check/ を削除しました (約 ${mb}MB)。`);
    }),
  );

  void checkEnvironment(context.workspaceState);
  void suggestAbortIfNeeded(context.workspaceState);
}

export function deactivate(): void {
  /* subscriptions で後始末する */
}
