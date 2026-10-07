import * as vscode from 'vscode';
import { createContext } from '../core/context';
import { runPipeline, type PipelineReport } from '../core/pipeline';
import type { StepId, StepResult } from '../core/types';
import { readSettings, selectedSteps, workspaceRoot } from './config';
import { Problems } from './diagnostics';
import { Outputs } from './output';

export type RunMode = 'check' | 'pre-debug' | 'build-debug';
export type NodeStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';

export interface Sink {
  line(text: string): void;
}

const ICON: Record<string, string> = { pass: '✔', fail: '✘', skip: '－' };

export class Runner implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private abort?: AbortController;
  private results = new Map<string, StepResult>();
  private running = new Set<string>();

  constructor(
    private readonly outputs: Outputs,
    private readonly problems: Problems,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  get isRunning(): boolean {
    return !!this.abort;
  }

  statusOf(id: StepId): NodeStatus {
    if (this.running.has(id)) return 'running';
    return this.results.get(id)?.status ?? 'pending';
  }

  resultOf(id: StepId): StepResult | undefined {
    return this.results.get(id);
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** 終了コード (0: 成功 / 1: 失敗・中止) を返す。task の終了コードにそのまま使う。 */
  async run(mode: RunMode, sink?: Sink): Promise<number> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('42 Check: フォルダを開いてから実行してください。');
      return 1;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('42 Check: 信頼されていないワークスペースでは実行できません (Makefile の評価と対象プログラムの実行を行うため)。');
      return 1;
    }
    if (this.abort) {
      void vscode.window.showWarningMessage('42 Check: すでに実行中です。');
      return 1;
    }

    const abort = new AbortController();
    this.abort = abort;
    this.results.clear();
    this.running.clear();
    this.problems.clear();
    this.outputs.clearAll();
    await vscode.commands.executeCommand('setContext', 'c42check.running', true);
    this.emitter.fire();

    const main = this.outputs.get('main');
    const say = (text: string) => {
      main.appendLine(text);
      sink?.line(text);
    };
    const settings = readSettings();
    const selected = mode === 'build-debug' ? [] : selectedSteps();
    say(`42 Check (${mode}) — failFast: ${settings.failFast}, 対象: ${selected.join(', ') || '(なし)'}`);

    let report: PipelineReport | undefined;
    try {
      const ctx = createContext({
        root,
        settings,
        signal: abort.signal,
        io: { log: (ch, text) => this.outputs.get(ch).append(text) },
      });
      report = await runPipeline(
        ctx,
        { selected, debugBuild: mode === 'pre-debug', debugBuildOnly: mode === 'build-debug' },
        {
          onStage: (stage, label) => say(`\n── ${label} ──`),
          onStepStart: (id, label) => {
            this.running.add(id);
            this.statusBar.text = `$(sync~spin) 42 Check: ${label}`;
            this.emitter.fire();
            say(`▶ ${label}`);
          },
          onStepEnd: (r) => this.onStepEnd(r, say),
        },
      );
    } catch (e) {
      say(`内部エラー: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    } finally {
      this.abort = undefined;
      this.running.clear();
      this.statusBar.text = '$(checklist) 42 Check';
      await vscode.commands.executeCommand('setContext', 'c42check.running', false);
      this.emitter.fire();
    }

    if (!report) return 1;
    this.summarize(report, say);
    return report.ok ? 0 : 1;
  }

  private onStepEnd(r: StepResult, say: (t: string) => void): void {
    this.running.delete(r.id);
    this.results.set(r.id, r);
    const ch = this.outputs.get(r.id === 'prepare' ? 'main' : r.label);
    if (r.log) ch.appendLine(r.log.trimEnd());
    this.problems.add(r.diags);
    const detail = r.reason ? ` — ${r.reason}` : '';
    say(`${ICON[r.status]} ${r.label}: ${r.status}${detail}${r.status === 'skip' && r.hint ? `\n    対処案: ${r.hint}` : ''}`);
    if (r.status === 'fail' && r.hint) say(`    対処案: ${r.hint}`);
    this.emitter.fire();
  }

  private summarize(report: PipelineReport, say: (t: string) => void): void {
    say('\n── 結果 ──');
    for (const r of report.results) say(`  ${ICON[r.status]} 段階${r.stage} ${r.label}: ${r.status}`);
    for (const n of report.notRun) say(`  ・ ${n.label}: 実行していません (前の失敗のため)`);
    if (report.skipped.length) {
      say(`\n⚠ skip が ${report.skipped.length} 件あります (失敗ではありません): ${report.skipped.map((s) => s.label).join(', ')}`);
    }
    const show = () => this.outputs.get('main').show(true);
    if (!report.ok && report.stoppedAt) {
      const s = report.stoppedAt;
      const where = s.stage === 0 ? '準備 (段階 0)' : `段階 ${s.stage} の ${s.label}`;
      say(`\n✘ ${where} で止まりました。後続の段階は実行していません。`);
      void vscode.window
        .showErrorMessage(
          `42 Check: ${where} で失敗しました${s.reason ? ` (${s.reason})` : ''}。後続の段階は実行していません。`,
          'ログを表示',
          'Problems を開く',
        )
        .then((pick) => {
          if (pick === 'ログを表示') {
            const id = s.id === 'prepare' ? 'main' : s.label;
            this.outputs.get(id).show(true);
          } else if (pick === 'Problems を開く') {
            void vscode.commands.executeCommand('workbench.actions.view.problems');
          }
        });
      show();
    } else {
      say('\n✔ すべて通りました。');
      const skipNote = report.skipped.length ? ` (skip ${report.skipped.length} 件: ${report.skipped.map((s) => s.label).join(', ')})` : '';
      void vscode.window.showInformationMessage(`42 Check: 通過しました${skipNote}`);
    }
  }

  dispose(): void {
    this.abort?.abort();
    this.emitter.dispose();
  }
}
