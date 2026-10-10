import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createContext } from '../core/context';
import { applyPlan, checkHeaderNorm, planSync, protoSourceRoot, syncAuto, type SyncPlan } from '../core/proto';
import { isFileDirty, readSettings, workspaceRoot } from './config';
import type { Problems } from './diagnostics';
import type { Outputs } from './output';
import type { Runner } from './runner';

const CHANNEL = 'プロトタイプ同期';
const SAVE_DEBOUNCE_MS = 400;

/** 「ヘッダにプロトタイプを反映」コマンドと、保存時の自動同期。 */
export class ProtoSync implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private lastError = '';

  constructor(
    private readonly outputs: Outputs,
    private readonly problems: Problems,
    private readonly runner: Runner,
  ) {}

  private makeContext() {
    const root = workspaceRoot();
    if (!root) return undefined;
    return createContext({ root, settings: readSettings(), isFileDirty, io: { log: () => undefined } });
  }

  /** コマンド: 差分をプレビューし、承認を取ってから書き込む。 */
  async runCommand(): Promise<void> {
    const ctx = this.makeContext();
    if (!ctx) {
      void vscode.window.showErrorMessage('42 Check: フォルダを開いてから実行してください。');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('42 Check: 信頼されていないワークスペースでは実行できません。');
      return;
    }
    if (this.runner.isRunning) {
      void vscode.window.showWarningMessage('42 Check: 検証の実行中は、ヘッダを書き換えられません。終わってからもう一度実行してください。');
      return;
    }
    const out = this.outputs.get(CHANNEL);
    out.clear();
    const rel = (p: string) => path.relative(ctx.root, p);

    let plan = await planSync(ctx);
    if (plan.kind === 'choose-header') {
      const pick = await vscode.window.showQuickPick(
        plan.candidates.map((c) => ({ label: rel(c), description: '', abs: c })),
        { title: 'プロトタイプを反映するヘッダを選んでください', placeHolder: '設定 c42check.proto.header に指定すると、次回から聞きません' },
      );
      if (!pick) return;
      plan = await planSync(ctx, { header: pick.abs });
    }
    await this.handlePlan(ctx, plan, out, rel);
  }

  private async handlePlan(
    ctx: ReturnType<typeof createContext>,
    plan: SyncPlan,
    out: vscode.OutputChannel,
    rel: (p: string) => string,
  ): Promise<void> {
    const show = 'ログを表示';
    switch (plan.kind) {
      case 'skip': {
        out.appendLine(`skip: ${plan.reason}\n対処案: ${plan.hint ?? '-'}`);
        const pick = await vscode.window.showWarningMessage(
          `42 Check: プロトタイプの反映を skip しました (${plan.reason})${plan.hint ? `。${plan.hint}` : ''}`,
          show,
        );
        if (pick === show) out.show(true);
        return;
      }
      case 'error': {
        out.appendLine(`エラー: ${plan.reason}\n対処案: ${plan.hint ?? '-'}\n${plan.log ?? ''}`);
        const pick = await vscode.window.showErrorMessage(`42 Check: ${plan.reason}${plan.hint ? `。${plan.hint}` : ''}`, show);
        if (pick === show) out.show(true);
        return;
      }
      case 'choose-header':
        return;
      case 'ready':
      case 'needs-markers':
        break;
    }

    if (isFileDirty(plan.header)) {
      void vscode.window.showErrorMessage(`42 Check: ${rel(plan.header)} に未保存の変更があります。保存してからもう一度実行してください。`);
      return;
    }
    out.appendLine(plan.log);
    if (plan.kind === 'ready' && !plan.changed) {
      void vscode.window.showInformationMessage(`42 Check: ${rel(plan.header)} のプロトタイプは最新です (${plan.count} 件、変更なし)。`);
      return;
    }

    // マーカーが無いときは勝手に挿入しない: 挿入位置を示して承認を取る。どちらの場合も、書き込み前に差分を見せる。
    const proposed = await vscode.workspace.openTextDocument({ content: plan.newText, language: 'c' });
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(plan.header),
      proposed.uri,
      `${rel(plan.header)} ↔ プロトタイプ反映案 (${plan.count} 件)`,
    );
    const tooLong = plan.tooLong.length ? ` ⚠ 80 桁を超える宣言があります (${plan.tooLong.join(', ')})。norm 違反になります。` : '';
    const question =
      plan.kind === 'needs-markers'
        ? `${rel(plan.header)} には auto prototypes のマーカーがありません。${plan.insertion.where} (${plan.insertion.line} 行目付近) に、マーカーごと ${plan.count} 件を挿入する案です。`
        : `${rel(plan.header)} のマーカーの間だけを、${plan.count} 件で書き換えます。`;
    const yes = plan.kind === 'needs-markers' ? 'マーカーを挿入して反映する' : '反映する';
    const pick = await vscode.window.showInformationMessage(`42 Check: ${question}${tooLong} 差分を確認してください。`, yes, 'キャンセル');
    if (pick !== yes) {
      out.appendLine('キャンセルされました (ヘッダは変更していません)');
      return;
    }
    if (fs.readFileSync(plan.header, 'utf8') !== plan.oldText) {
      void vscode.window.showErrorMessage(`42 Check: 差分を表示している間に ${rel(plan.header)} が変更されました。もう一度実行してください。`);
      return;
    }

    const previous = applyPlan(plan);
    out.appendLine(`${rel(plan.header)} を書き換えました`);
    const norm = await checkHeaderNorm(ctx, plan.header);
    out.appendLine(norm.log);
    this.problems.add(norm.diags);
    if (norm.status === 'fail') {
      const undo = '元に戻す';
      const choice = await vscode.window.showWarningMessage(
        `42 Check: ${rel(plan.header)} に反映しましたが、norminette が ${norm.diags.length || '複数の'} 件を指摘しています。`,
        undo,
        show,
      );
      if (choice === undo) {
        fs.writeFileSync(plan.header, previous);
        out.appendLine('元に戻しました');
      } else if (choice === show) out.show(true);
      return;
    }
    const normNote = norm.status === 'pass' ? 'norminette: OK' : `norminette: ${norm.reason ?? 'skip'}`;
    void vscode.window.showInformationMessage(`42 Check: ${rel(plan.header)} に ${plan.count} 件を反映しました (${normNote})。`);
  }

  /** 保存時の同期。差分プレビューは出さない (保存のたびに承認を求めると使えないため)。マーカーがあるときだけ書き換える。 */
  onSaved(doc: vscode.TextDocument): void {
    const settings = readSettings();
    if (!settings.protoSyncOnSave || !doc.fileName.endsWith('.c') || this.runner.isRunning) return;
    const root = workspaceRoot();
    if (!root) return;
    const srcRoot = path.resolve(root, settings.protoSourceDir || settings.targetDir);
    const rel = path.relative(srcRoot, doc.fileName);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.chain = this.chain.then(() => this.syncOnSave()).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }

  private async syncOnSave(): Promise<void> {
    const ctx = this.makeContext();
    if (!ctx || this.runner.isRunning) return;
    const out = this.outputs.get(CHANNEL);
    const r = await syncAuto(ctx);
    if (r.status === 'unchanged') return;
    out.appendLine(`[保存時] ${r.status}: ${r.message}${r.hint ? ` — ${r.hint}` : ''}`);
    if (r.log) out.appendLine(r.log);
    switch (r.status) {
      case 'updated':
        this.lastError = '';
        if (r.norm) this.problems.add(r.norm.diags);
        if (r.norm?.status === 'fail') void vscode.window.showWarningMessage(`42 Check: ${r.message}`, 'ログを表示').then((p) => p && out.show(true));
        else vscode.window.setStatusBarMessage(`$(sync) 42 Check: プロトタイプを同期しました (${r.count} 件)`, 4000);
        break;
      case 'error':
        // 同じエラーを保存のたびに出し続けない
        if (r.message !== this.lastError) {
          this.lastError = r.message;
          void vscode.window.showErrorMessage(`42 Check: ${r.message}${r.hint ? `。${r.hint}` : ''}`, 'ログを表示').then((p) => p && out.show(true));
        }
        break;
      default:
        vscode.window.setStatusBarMessage(`42 Check: プロトタイプ同期を飛ばしました (${r.message})`, 6000);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export { protoSourceRoot };
