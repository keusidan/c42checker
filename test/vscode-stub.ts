// テスト専用の `vscode` module 代替 (esbuild の alias で差し替える)。
// UI 層の制御フロー (Runner → Task の終了コード) を、VS Code 本体なしで検証するための最小実装。
// VS Code 本体の挙動 (preLaunchTask が非 0 でデバッガを止める等) は検証できない。

export const state = {
  folders: [] as { uri: { fsPath: string } }[],
  config: {} as Record<string, unknown>,
  trusted: true,
  messages: [] as string[],
  updates: [] as { key: string; value: unknown }[],
};

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => undefined };
  };
  fire(e?: T): void {
    for (const l of this.listeners) l(e as T);
  }
  dispose(): void {
    this.listeners = [];
  }
}

const ok = async (m: string): Promise<undefined> => {
  state.messages.push(m);
  return undefined;
};

export const window = {
  createOutputChannel: (name: string) => ({
    name,
    text: '',
    append(t: string) {
      this.text += t;
    },
    appendLine(t: string) {
      this.text += t + '\n';
    },
    clear() {
      this.text = '';
    },
    show: () => undefined,
    dispose: () => undefined,
  }),
  showErrorMessage: ok,
  showWarningMessage: ok,
  showInformationMessage: ok,
};

export const workspace = {
  get workspaceFolders() {
    return state.folders;
  },
  get isTrusted() {
    return state.trusted;
  },
  getConfiguration: (section: string) => ({
    get: (key: string) => state.config[`${section}.${key}`],
    update: async (key: string, value: unknown) => {
      state.config[`${section}.${key}`] = value;
      state.updates.push({ key: `${section}.${key}`, value });
    },
  }),
};

export const commands = { executeCommand: async () => undefined };

export const languages = {
  createDiagnosticCollection: () => ({
    entries: new Map<string, unknown[]>(),
    clear() {
      this.entries.clear();
    },
    set(uri: { fsPath: string }, list: unknown[]) {
      this.entries.set(uri.fsPath, list);
    },
    dispose: () => undefined,
  }),
};

export const Uri = { file: (fsPath: string) => ({ fsPath }) };
export class Range {
  constructor(
    public sl: number,
    public sc: number,
    public el: number,
    public ec: number,
  ) {}
}
export class Diagnostic {
  source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: number,
  ) {}
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ConfigurationTarget = { Workspace: 2 };

export const TaskScope = { Workspace: 2 };
export class CustomExecution {
  constructor(public callback: () => Promise<unknown>) {}
}
export class Task {
  group: unknown;
  constructor(
    public definition: Record<string, unknown>,
    public scope: unknown,
    public name: string,
    public source: string,
    public execution: CustomExecution,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };
export class TreeItem {
  id?: string;
  checkboxState?: number;
  iconPath?: unknown;
  description?: string;
  tooltip?: unknown;
  command?: { command: string; title: string };
  constructor(
    public label: string,
    public collapsibleState: number,
  ) {}
}
export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  value = '';
  appendMarkdown(t: string) {
    this.value += t;
    return this;
  }
}
