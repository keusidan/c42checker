import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from './exec';
import { parseCompilerOutput } from './parse';
import type { Context, Diag } from './types';

/** 動的チェック・デバッグ用ビルドが使う入力 (.c の一覧)。main が無ければ mainFile を足す。 */
export function buildInputs(ctx: Context): { files: string[]; usable: boolean; note?: string } {
  if (ctx.sources.length === 0) return { files: [], usable: false };
  if (ctx.hasMain) {
    return {
      files: ctx.sources,
      usable: true,
      note: ctx.mainFile ? 'ソースに main があるため c42check.mainFile は使いません' : undefined,
    };
  }
  if (ctx.mainFile) return { files: [...ctx.sources, ctx.mainFile], usable: true };
  return { files: ctx.sources, usable: false };
}

export const NO_MAIN_REASON = '対象ソースに main がありません';
export const NO_MAIN_HINT =
  'ライブラリ課題 (libft 等) は、テスト用の main (.c) を作り、設定 `c42check.mainFile` にそのパスを指定してください';

export interface BuildResult {
  ok: boolean;
  bin: string;
  output: string;
  diags: Diag[];
}

/** 1 回の compile + link。成果物は outDir/prog。 */
export async function buildBinary(
  ctx: Context,
  outDir: string,
  flags: string[],
  source: string,
): Promise<BuildResult> {
  const cc = ctx.tools.cc;
  const bin = path.join(outDir, 'prog');
  fs.mkdirSync(outDir, { recursive: true });
  if (!cc) return { ok: false, bin, output: 'clang が見つかりません\n', diags: [] };
  const { files } = buildInputs(ctx);
  const args = [...flags, ...ctx.includeDirs.map((d) => `-I${d}`), '-o', bin, ...files];
  const r = await exec(cc, args, {
    cwd: ctx.root,
    timeoutMs: ctx.settings.staticTimeoutSec * 1000,
    signal: ctx.signal,
  });
  const header = `$ ${cc} ${args.join(' ')}\n`;
  return {
    ok: r.code === 0 && !r.error && fs.existsSync(bin),
    bin,
    output: header + r.output + (r.error ? `${r.error}\n` : ''),
    diags: parseCompilerOutput(r.output, ctx.root, source),
  };
}

export const DEBUG_FLAGS = ['-g', '-O0', '-fno-omit-frame-pointer', '-pthread'];

export function debugFlags(ctx: Context): string[] {
  return ctx.settings.debugSanitizer
    ? [...DEBUG_FLAGS, '-fsanitize=address,undefined']
    : DEBUG_FLAGS;
}
