export const STEP_IDS = [
  'cFormatter', // norminette の前に走らせる整形 (ファイルを書き換える)
  'norminette',
  'warnings',
  'clangTidy',
  'scanBuild',
  'gccAnalyzer',
  'asanUbsan',
  'tsan',
  'msan',
  'valgrind',
  'cbmc',
  'framaC',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type Stage = 1 | 2;
export type StepStatus = 'pass' | 'fail' | 'skip';
export type Severity = 'error' | 'warning' | 'info';
export type FailFast = 'stage' | 'step';
export type CompdbSource = 'auto' | 'files' | 'make-n' | 'clang-MJ';

export interface Diag {
  file: string; // 絶対パス
  line: number; // 1 始まり
  col: number; // 1 始まり (不明なら 1)
  severity: Severity;
  message: string;
  source: string; // ツール名
}

export interface StepOutcome {
  status: StepStatus;
  diags: Diag[];
  log: string;
  /** skip / fail の理由 (1 行) */
  reason?: string;
  /** skip のときの対処案 */
  hint?: string;
}

export interface StepResult extends StepOutcome {
  id: StepId | 'prepare' | 'debug-build';
  label: string;
  stage: number;
  ms: number;
}

export interface Settings {
  targetDir: string;
  includePaths: string[];
  runArgs: string[];
  useMakeCheckTarget: boolean;
  failFast: FailFast;
  minFreeSpaceMB: number;
  workDirMaxMB: number;
  runTimeoutSec: number;
  staticTimeoutSec: number;
  mainFile: string;
  compdbIncludeMain: boolean;
  compdbSource: CompdbSource;
  debugSanitizer: boolean;
  /** プロトタイプ同期: 書き換え対象のヘッダ (root からの相対パス。空なら自動判定) */
  protoHeader: string;
  /** プロトタイプ同期: 関数定義を抽出する .c のディレクトリ (空なら targetDir) */
  protoSourceDir: string;
  protoSyncOnRun: boolean;
  protoSyncOnSave: boolean;
  /** コンパイル引数 (VS Code の settings.json の c42check.compile.* / clangTidy.* / valgrind.*) */
  compileCflags: string[];
  compileLdflags: string[];
  compileLibs: string[];
  compileWarningFlags: string[];
  compilePerStep: Partial<Record<StepId, string[]>>;
  clangTidyChecks: string;
  valgrindArgs: string[];
  checks: Record<StepId, boolean>;
}

export const DEFAULT_CHECKS: Record<StepId, boolean> = {
  cFormatter: false, // ソースを書き換えるため既定は OFF
  norminette: true,
  warnings: true,
  clangTidy: true,
  scanBuild: true,
  gccAnalyzer: true,
  asanUbsan: true,
  tsan: false,
  msan: false,
  valgrind: true,
  cbmc: false,
  framaC: false,
};

export const DEFAULT_SETTINGS: Settings = {
  targetDir: '.',
  includePaths: [],
  runArgs: [],
  useMakeCheckTarget: false,
  failFast: 'stage',
  minFreeSpaceMB: 200,
  workDirMaxMB: 100,
  runTimeoutSec: 10,
  staticTimeoutSec: 120,
  mainFile: '',
  compdbIncludeMain: true,
  compdbSource: 'auto',
  debugSanitizer: false,
  protoHeader: '',
  protoSourceDir: '',
  protoSyncOnRun: false,
  protoSyncOnSave: false,
  compileCflags: [],
  compileLdflags: [],
  compileLibs: [],
  compileWarningFlags: ['-Wall', '-Wextra', '-Werror', '-Wshadow', '-Wconversion'],
  compilePerStep: {},
  clangTidyChecks: 'clang-analyzer-*,bugprone-*',
  valgrindArgs: ['--leak-check=full', '--show-leak-kinds=all', '--track-fds=yes'],
  checks: { ...DEFAULT_CHECKS },
};

/** 検出したツールの実行ファイル名 (見つからなければ undefined) */
export interface Tools {
  cc?: string; // clang-12 → clang
  tidy?: string; // clang-tidy-12 → clang-tidy
  scanBuild?: string; // scan-build-12 → scan-build
  gcc?: string; // gcc-12 → gcc
  valgrind?: string;
  norminette?: string;
  make?: string;
  cbmc?: string;
  framaC?: string;
  /** PATH 上の候補名。Universal Ctags かどうかは使う直前に --version で確認する */
  ctags?: string;
  cFormatter?: string;
  /** util-linux の setarch。TSan / MSan を ASLR 無効 (setarch -R) で起動するのに使う */
  setarch?: string;
}

export interface RunIO {
  log(channel: string, text: string): void;
}

export interface Context {
  root: string; // ワークスペースルート (絶対)
  targetRoot: string; // 検証対象ディレクトリ (絶対)
  workDir: string; // root/.42check
  settings: Settings;
  tools: Tools;
  sources: string[]; // 絶対パスの .c
  headers: string[]; // 絶対パスの .h
  includeDirs: string[]; // 絶対パス
  hasMain: boolean;
  mainFile?: string; // 設定された mainFile (絶対)。存在する場合のみ
  hasMakefile: boolean;
  io: RunIO;
  signal?: AbortSignal;
  /** エディタで未保存の変更があるファイルか (ヘッダを上書きしないため)。VS Code 側から渡す */
  isFileDirty?: (absPath: string) => boolean;
}
