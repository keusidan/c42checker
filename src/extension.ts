import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { generateClangd, generateCompdb } from './core/compdb';
import { createContext } from './core/context';
import { shellQuoteArgs } from './core/launchConfig';
import { dirSize } from './core/workdir';
import { readSettings, workspaceRoot } from './ui/config';
import { Problems } from './ui/diagnostics';
import { checkEnvironment } from './ui/envCheck';
import { generateDebugConfig, proposeAbortOnTaskErrors, suggestAbortIfNeeded } from './ui/launchGen';
import { Outputs } from './ui/output';
import { Runner } from './ui/runner';
import { CheckTaskProvider } from './ui/taskProvider';
import { CheckTree } from './ui/tree';

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
  const treeView = vscode.window.createTreeView('c42check.view', { treeDataProvider: tree });

  const reg = vscode.commands.registerCommand;
  context.subscriptions.push(
    outputs,
    problems,
    statusBar,
    runner,
    tree,
    treeView,
    treeView.onDidChangeCheckboxState((e) => void tree.onCheckbox(e.items)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('c42check')) tree.refresh();
    }),
    vscode.tasks.registerTaskProvider(CheckTaskProvider.type, new CheckTaskProvider(runner)),

    reg('c42check.run', () => runner.run('check')),
    reg('c42check.cancel', () => runner.cancel()),
    reg('c42check.refresh', () => tree.refresh()),
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
        const r = await generateCompdb(ctx);
        const c = generateClangd(root);
        void vscode.window.showInformationMessage(
          `42 Check: compile_commands.json を再生成しました (${r.method}, ${r.entries} 件)。${c.written ? '.clangd も更新しました。' : (c.reason ?? '')}${r.note ? ` ${r.note}` : ''}`,
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
      fs.rmSync(ctx.workDir, { recursive: true, force: true });
      void vscode.window.showInformationMessage(`42 Check: .42check/ を削除しました (約 ${mb}MB)。`);
    }),
  );

  void checkEnvironment(context.workspaceState);
  void suggestAbortIfNeeded(context.workspaceState);
}

export function deactivate(): void {
  /* subscriptions で後始末する */
}
