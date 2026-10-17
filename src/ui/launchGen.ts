import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildLaunchConfigs, buildTasks, mergeJsonFile, usesC42check, type MergeResult } from '../core/launchConfig';
import { debugLaunchOptions, workspaceRoot } from './config';

interface Target {
  file: string;
  listKey: 'configurations' | 'tasks';
  idKey: 'name' | 'label';
  desired: Record<string, unknown>[];
}

/**
 * .vscode/launch.json と tasks.json を生成・更新する。
 * ファイルが無ければ作成。既にあれば上書きせず、マージ案を差分表示して承認を取ってから書く。
 */
export async function generateDebugConfig(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage('42 Check: フォルダを開いてから実行してください。');
    return;
  }
  const dir = path.join(root, '.vscode');
  const targets: Target[] = [
    { file: path.join(dir, 'tasks.json'), listKey: 'tasks', idKey: 'label', desired: buildTasks() },
    {
      file: path.join(dir, 'launch.json'),
      listKey: 'configurations',
      idKey: 'name',
      desired: buildLaunchConfigs(debugLaunchOptions()),
    },
  ];

  let changed = 0;
  for (const t of targets) {
    const existing = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : undefined;
    let merge: MergeResult;
    try {
      merge = mergeJsonFile(existing, t.listKey, t.idKey, t.desired, t.listKey === 'tasks' ? '2.0.0' : '0.2.0');
    } catch (e) {
      void vscode.window.showErrorMessage(`42 Check: ${path.basename(t.file)} を解析できませんでした (${String(e)})。手動で修正してから再実行してください。`);
      continue;
    }
    if (merge.merged === null) continue;

    if (existing === undefined) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(t.file, merge.merged);
      changed++;
      continue;
    }
    // 既存ファイルがある: 上書きせず、差分を見せて承認を取る
    const proposed = await vscode.workspace.openTextDocument({ content: merge.merged, language: 'jsonc' });
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(t.file),
      proposed.uri,
      `${path.basename(t.file)} ↔ マージ案 (追加: ${merge.added.join(', ')})`,
    );
    const pick = await vscode.window.showWarningMessage(
      `${path.basename(t.file)} に ${merge.added.length} 件を追加します (既存の項目は変更しません)。JSON として書き出すため、既存のコメントは失われます。適用しますか?`,
      { modal: true },
      '適用する',
    );
    if (pick === '適用する') {
      fs.writeFileSync(t.file, merge.merged);
      changed++;
    }
  }

  void vscode.window.showInformationMessage(
    changed > 0 ? '42 Check: launch.json / tasks.json を更新しました。F5 で事前チェック付きのデバッグを開始できます。' : '42 Check: launch.json / tasks.json は最新です (変更なし)。',
  );
  await proposeAbortOnTaskErrors(false);
}

/** debug.onTaskErrors を abort にする提案。承認なしには設定を書き換えない。 */
export async function proposeAbortOnTaskErrors(force: boolean): Promise<void> {
  const debugCfg = vscode.workspace.getConfiguration('debug');
  const current = debugCfg.get<string>('onTaskErrors');
  if (current === 'abort') {
    if (force) void vscode.window.showInformationMessage('42 Check: debug.onTaskErrors はすでに abort です。');
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `事前チェックに落ちたときにデバッガを確実に起動させないため、このワークスペースの debug.onTaskErrors を "abort" にすることを提案します (現在: "${current ?? 'prompt'}"。既定の prompt だと「このまま続行」を選べてしまいます)。変更しますか?`,
    { modal: true },
    'abort にする',
  );
  if (pick === 'abort にする') {
    await debugCfg.update('onTaskErrors', 'abort', vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage('42 Check: debug.onTaskErrors を abort にしました (ワークスペース設定)。');
  }
}

/** launch.json が 42 Check の構成を使っているのに abort でなければ、一度だけ提案する。 */
export async function suggestAbortIfNeeded(state: vscode.Memento): Promise<void> {
  const root = workspaceRoot();
  if (!root || state.get<boolean>('c42check.abortSuggested')) return;
  const launch = path.join(root, '.vscode', 'launch.json');
  if (!fs.existsSync(launch) || !usesC42check(fs.readFileSync(launch, 'utf8'))) return;
  if (vscode.workspace.getConfiguration('debug').get<string>('onTaskErrors') === 'abort') return;
  await state.update('c42check.abortSuggested', true);
  const pick = await vscode.window.showInformationMessage(
    '42 Check: 事前チェック失敗時にデバッガを確実に止めるには debug.onTaskErrors を abort にします。',
    '確認する',
  );
  if (pick === '確認する') await proposeAbortOnTaskErrors(true);
}
