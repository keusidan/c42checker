import { accessSync, constants, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StepId, Tools } from './types';

/** 先に書いたものを優先する。校舎は -12 系、メイン機 (Arch) は素の名前。 */
export const CANDIDATES: Record<keyof Tools, string[]> = {
  cc: ['clang-12', 'clang'],
  tidy: ['clang-tidy-12', 'clang-tidy'],
  scanBuild: ['scan-build-12', 'scan-build'],
  gcc: ['gcc-12', 'gcc'],
  valgrind: ['valgrind'],
  norminette: ['norminette'],
  make: ['make'],
  cbmc: ['cbmc'],
  framaC: ['frama-c'],
  // Ubuntu は ctags-universal (ctags は alternatives)。素の ctags は Exuberant / GNU 版のことがあるので最後
  ctags: ['universal-ctags', 'ctags-universal', 'ctags'],
  // PyPI の c-formatter-42 が入れるコマンド名は c_formatter_42
  cFormatter: ['c_formatter_42', 'c-formatter-42'],
  setarch: ['setarch'],
};

export function findOnPath(name: string, envPath = process.env.PATH ?? ''): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* 次の候補へ */
    }
  }
  return undefined;
}

/** `base-<N>` 形式の実行ファイルのうち、最も新しい版を返す (例: scan-build-18 のみ入っている環境向け)。 */
export function findHighestVersioned(base: string, envPath = process.env.PATH ?? ''): string | undefined {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let best: { name: string; n: number } | undefined;
  for (const dir of envPath.split(path.delimiter)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (m && findOnPath(name, dir) && (!best || Number(m[1]) > best.n)) best = { name, n: Number(m[1]) };
    }
  }
  return best?.name;
}

/** 校舎の指定版 (-12) → 素の名前 → 入っている最新の版、の順で探す。 */
/** setarch に渡すアーキテクチャ名 (x86_64 / aarch64)。分からなければ省略する (新しい util-linux は省略できる)。 */
export function machineArch(): string[] {
  const m = typeof os.machine === 'function' ? os.machine() : '';
  return m ? [m] : [];
}

export function detectTools(envPath = process.env.PATH ?? ''): Tools {
  const tools: Tools = {};
  for (const key of Object.keys(CANDIDATES) as (keyof Tools)[]) {
    const found =
      CANDIDATES[key].find((name) => findOnPath(name, envPath)) ??
      (key === 'cc' || key === 'tidy' || key === 'scanBuild' || key === 'gcc'
        ? findHighestVersioned(CANDIDATES[key][CANDIDATES[key].length - 1], envPath)
        : undefined);
    if (found) tools[key] = found;
  }
  return tools;
}

/** 各ステップが必要とするツール (View で未検出を表示するため) */
export const STEP_TOOL: Record<StepId, keyof Tools> = {
  cFormatter: 'cFormatter',
  norminette: 'norminette',
  warnings: 'cc',
  clangTidy: 'tidy',
  scanBuild: 'scanBuild',
  gccAnalyzer: 'gcc',
  asanUbsan: 'cc',
  tsan: 'cc',
  msan: 'cc',
  valgrind: 'valgrind',
  cbmc: 'cbmc',
  framaC: 'framaC',
};

/** skip 理由に添える、未検出ツールごとの対処案 */
export const INSTALL_HINTS: Record<keyof Tools, string> = {
  cc: 'clang (校舎: clang-12 系) が PATH にありません。Arch: `sudo pacman -S clang`',
  tidy: 'clang-tidy (校舎: clang-tidy-12) が PATH にありません。Arch: `sudo pacman -S clang` (clang-tidy 同梱)',
  scanBuild: 'scan-build (校舎: scan-build-12) が PATH にありません。Arch: `sudo pacman -S clang-analyzer`',
  gcc: 'gcc (校舎: gcc-12) が PATH にありません。-fanalyzer は GCC 10 以降が必要です',
  valgrind: 'valgrind が PATH にありません。Arch: `sudo pacman -S valgrind`',
  norminette: 'norminette が PATH にありません。校舎では標準で入っています。自分の機では `pipx install norminette` 等',
  make: 'make が PATH にありません',
  cbmc: 'cbmc が PATH にありません。ネイティブ版のみ対応です (校舎では Docker image を pull しない方針)',
  framaC: 'frama-c が PATH にありません。ネイティブ版のみ対応です (校舎では Docker image を pull しない方針)',
  ctags: 'universal-ctags (ctags-universal) が PATH にありません。Arch: `sudo pacman -S ctags` / Ubuntu: `sudo apt install universal-ctags`。プロトタイプ同期のみで使います',
  setarch: 'setarch (util-linux) が PATH にありません。TSan / MSan は ASLR 無効 (setarch -R) で起動しないと、環境によって起動できないことがあります',
  cFormatter: 'c_formatter_42 が PATH にありません。`pipx install c-formatter-42` (または `pip install --user c-formatter-42`) で入ります。自分の機の norminette と同じように、校舎の home に入れる場合は容量に注意してください',
};
