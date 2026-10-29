import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createContext } from '../core/context';
import { applyPlan, checkHeaderNorm, planSync, protoSourceRoot, syncAuto, type SyncPlan } from '../core/proto';
import { isFileDirty, readSettings, workspaceRoot } from './config';
import type { Problems } from './diagnostics';
import type { Outputs } from './output';
import type { Runner } from './runner';

/** 反映案を載せる読み取り専用の仮想ドキュメントの scheme (無題の新規ドキュメントにすると、保存ダイアログが出てしまう) */
export const PROPOSAL_SCHEME = 'c42check-proposal';
const CHANNEL = 'プロトタイプ同期';
const SAVE_DEBOUNCE_MS = 400;

/** 反映案の内容を返すだけの、読み取り専用の仮想ドキュメント。編集も保存もできない。 */
export class ProposalProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

function isProposalTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } {
  return tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === PROPOSAL_SCHEME;
}

interface Pending {
  ctx: ReturnType<typeof createContext>;
  plan: Extract<SyncPlan, { kind: 'ready' | 'needs-markers' }>;
  uri: vscode.Uri;
}

/** 「ヘッダにプロトタイプを反映」コマンドと、保存時の自動同期。 */
export class ProtoSync implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private lastError = '';
  readonly provider = new ProposalProvider();
  private pending: Pending | undefined;
  private seq = 0;
  private readonly tabSub: vscode.Disposable;

  constructor(
    private readonly outputs: Outputs,
    private readonly problems: Problems,
    private readonly runner: Runner,
  ) {
    // 利用者が差分のタブを (×で) 閉じたら、反映案も捨てる
    this.tabSub = vscode.window.tabGroups.onDidChangeTabs((e) => {
      const p = this.pending;
      if (p && e.closed.some((t) => isProposalTab(t) && t.input.modified.toString() === p.uri.toString())) {
        this.provider.delete(p.uri);
        this.pending = undefined;
      }
      this.updateActiveContext();
    });
  }

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
      vscode.window.setStatusBarMessage(`42 Check: ${rel(plan.header)} のプロトタイプは最新です (${plan.count} 件、変更なし)`, 4000);
      return;
    }
    await this.showProposal(ctx, plan, rel);
  }

  /**
   * 反映案を、読み取り専用の仮想ドキュメント (c42check-proposal:) との差分として開く。
   * 承認は通知ではなく、差分エディタのタイトルバーのボタン (反映する / キャンセル) で行う。
   * マーカーが無いときは勝手に挿入せず、挿入した形をこの差分で見せる。
   */
  private async showProposal(
    ctx: ReturnType<typeof createContext>,
    plan: Extract<SyncPlan, { kind: 'ready' | 'needs-markers' }>,
    rel: (p: string) => string,
  ): Promise<void> {
    this.discardProposal(); // 前の案が開いたままなら閉じる
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${rel(plan.header).split(path.sep).join('/')}`, query: String(++this.seq) });
    this.provider.set(uri, plan.newText);
    this.pending = { ctx, plan, uri };
    const notes = [
      plan.kind === 'needs-markers' ? `マーカーが無いため ${plan.insertion.line} 行目付近に挿入する案` : undefined,
      plan.skippedExisting > 0 ? `手書きの宣言 ${plan.skippedExisting} 件は除外` : undefined,
      plan.tooLong.length > 0 ? `⚠ 80 桁超 ${plan.tooLong.length} 件` : undefined,
    ].filter((x): x is string => !!x);
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(plan.header),
      uri,
      `${rel(plan.header)} ↔ プロトタイプ反映案 (${plan.count} 件${notes.length ? `、${notes.join('、')}` : ''})`,
    );
    this.updateActiveContext();
  }

  /** 「いま開いているエディタが、反映案の差分か」。タイトルバーのボタンの表示条件 (c42check.proposalActive) に使う。 */
  private updateActiveContext(): void {
    const active = vscode.window.tabGroups.activeTabGroup?.activeTab;
    void vscode.commands.executeCommand('setContext', 'c42check.proposalActive', !!active && isProposalTab(active));
  }

  /** 差分エディタの「反映する」ボタン。成功したときは、通知を出さない (差分を閉じ、ヘッダが書き換わる)。 */
  async applyProposal(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    const { ctx, plan } = p;
    const rel = path.relative(ctx.root, plan.header);
    if (this.runner.isRunning) {
      void vscode.window.showErrorMessage('42 Check: 検証の実行中は、ヘッダを書き換えられません。終わってから、もう一度「反映する」を押してください。');
      return;
    }
    if (isFileDirty(plan.header)) {
      void vscode.window.showErrorMessage(`42 Check: ${rel} に未保存の変更があります。保存してから、もう一度「反映する」を押してください。`);
      return;
    }
    if (fs.readFileSync(plan.header, 'utf8') !== plan.oldText) {
      this.discardProposal();
      void vscode.window.showErrorMessage(`42 Check: 差分を表示している間に ${rel} が変更されました。もう一度「ヘッダにプロトタイプを反映」を実行してください。`);
      return;
    }

    const out = this.outputs.get(CHANNEL);
    const previous = applyPlan(plan);
    this.discardProposal();
    out.appendLine(`${rel} を書き換えました (${plan.count} 件)`);
    const norm = await checkHeaderNorm(ctx, plan.header);
    out.appendLine(norm.log);
    this.problems.add(norm.diags);
    if (norm.status !== 'fail') return; // 通過 (または norminette が無い) ときは、何も表示しない

    const undo = '元に戻す';
    const show = 'ログを表示';
    const choice = await vscode.window.showWarningMessage(
      `42 Check: ${rel} に反映しましたが、norminette が ${norm.diags.length || '複数の'} 件を指摘しています。`,
      undo,
      show,
    );
    if (choice === undo) {
      fs.writeFileSync(plan.header, previous);
      out.appendLine('元に戻しました');
    } else if (choice === show) out.show(true);
  }

  /** 差分エディタの「キャンセル」ボタン。ヘッダは変更しない。 */
  cancelProposal(): void {
    if (!this.pending) return;
    this.outputs.get(CHANNEL).appendLine('キャンセルされました (ヘッダは変更していません)');
    this.discardProposal();
  }

  /** 反映案の差分エディタを閉じ、保持している案を捨てる。 */
  private discardProposal(): void {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    this.provider.delete(p.uri);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (isProposalTab(tab) && tab.input.modified.toString() === p.uri.toString()) void vscode.window.tabGroups.close(tab);
      }
    }
    void vscode.commands.executeCommand('setContext', 'c42check.proposalActive', false);
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
    this.discardProposal();
    this.tabSub.dispose();
  }
}

export { protoSourceRoot };
