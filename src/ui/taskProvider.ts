import * as vscode from 'vscode';
import type { RunMode, Runner } from './runner';

const MODES: RunMode[] = ['check', 'pre-debug', 'build-debug'];

/** 失敗時は終了コード非 0 でクローズし、preLaunchTask として F5 のデバッガ起動を止められるようにする。 */
class CheckTerminal implements vscode.Pseudoterminal {
  private readonly write = new vscode.EventEmitter<string>();
  private readonly close_ = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.write.event;
  readonly onDidClose = this.close_.event;

  constructor(
    private readonly runner: Runner,
    private readonly mode: RunMode,
  ) {}

  open(): void {
    void this.runner
      .run(this.mode, { line: (t) => this.write.fire(t.replace(/\r?\n/g, '\r\n') + '\r\n') })
      .then((code) => this.close_.fire(code))
      .catch(() => this.close_.fire(1));
  }

  close(): void {
    this.runner.cancel();
  }
}

export class CheckTaskProvider implements vscode.TaskProvider {
  static readonly type = 'c42check';

  constructor(private readonly runner: Runner) {}

  provideTasks(): vscode.Task[] {
    return MODES.map((mode) => this.make({ type: CheckTaskProvider.type, mode } as vscode.TaskDefinition, mode, mode));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const mode = task.definition.mode as RunMode | undefined;
    if (!mode || !MODES.includes(mode)) return undefined;
    return this.make(task.definition, task.name, mode);
  }

  private make(def: vscode.TaskDefinition, name: string, mode: RunMode): vscode.Task {
    const task = new vscode.Task(
      def,
      vscode.TaskScope.Workspace,
      name,
      CheckTaskProvider.type,
      new vscode.CustomExecution(async () => new CheckTerminal(this.runner, mode)),
    );
    task.group = undefined;
    return task;
  }
}
