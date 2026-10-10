import * as fs from 'node:fs';
import * as path from 'node:path';
import { extraCflags, normalizeArgs, stepArgs } from './args';
import { buildBinary, buildInputs, NO_MAIN_HINT, NO_MAIN_REASON } from './build';
import { exec } from './exec';
import {
  dedupe,
  parseCbmc,
  parseCompilerOutput,
  parseFramaC,
  parseNorminette,
  parseSanitizer,
  parseValgrind,
  stripAnsi,
} from './parse';
import { makeTargetExists, findMakefile } from './sources';
import { INSTALL_HINTS } from './tools';
import { copyProject } from './workdir';
import type { Context, Diag, Stage, StepId, StepOutcome, Tools } from './types';

export interface Skip {
  reason: string;
  hint?: string;
}

export interface StepDef {
  id: StepId;
  label: string;
  stage: Stage;
  /** View のツールチップに出す補足 */
  note?: string;
  /** 未インストールなど、実行できない理由があれば返す (skip 扱い) */
  prerequisite(ctx: Context): Skip | undefined;
  run(ctx: Context): Promise<StepOutcome>;
}

const NO_SOURCES: Skip = {
  reason: '対象の .c ファイルがありません',
  hint: '設定 `c42check.targetDir` を確認してください',
};

function needTool(ctx: Context, key: keyof Tools, label: string): Skip | undefined {
  return ctx.tools[key] ? undefined : { reason: `${label} が見つかりません`, hint: INSTALL_HINTS[key] };
}

function first(...skips: (Skip | undefined)[]): Skip | undefined {
  return skips.find((s) => s);
}

function noSources(ctx: Context): Skip | undefined {
  return ctx.sources.length === 0 ? NO_SOURCES : undefined;
}

function needMain(ctx: Context): Skip | undefined {
  return buildInputs(ctx).usable ? undefined : { reason: NO_MAIN_REASON, hint: NO_MAIN_HINT };
}

const staticMs = (ctx: Context) => ctx.settings.staticTimeoutSec * 1000;
const incFlags = (ctx: Context) => ctx.includeDirs.map((d) => `-I${d}`);
const cmdline = (cmd: string, args: string[]) => `$ ${cmd} ${args.join(' ')}\n`;

function hasError(diags: Diag[]): boolean {
  return diags.some((d) => d.severity === 'error');
}

function verdict(code: number | null, diags: Diag[], output: string, extra?: { error?: string; timedOut?: boolean }): StepOutcome {
  if (extra?.timedOut) {
    return { status: 'fail', diags, log: output, reason: '制限時間 (c42check.staticTimeoutSec) を超えました' };
  }
  if (extra?.error) return { status: 'fail', diags, log: output, reason: extra.error };
  const failed = code !== 0 || hasError(diags);
  return {
    status: failed ? 'fail' : 'pass',
    diags,
    log: output,
    reason: failed ? `終了コード ${code}${hasError(diags) ? `、error 診断 ${diags.filter((d) => d.severity === 'error').length} 件` : ''}` : undefined,
  };
}

/* ───────────── 段階 1 ───────────── */

/** c_formatter_42 が整形した結果。整形前の内容は format-backup/ に退避される。 */
const cFormatter: StepDef = {
  id: 'cFormatter',
  label: 'c_formatter_42 (整形)',
  stage: 1,
  note: 'norminette の前に、.c / .h を **その場で書き換えて** 整形します (`#include` の並び替えも行います)。変更前の内容は .42check/format-backup/ に退避されます。',
  prerequisite: (ctx) =>
    first(needTool(ctx, 'cFormatter', 'c_formatter_42'), ctx.sources.length + ctx.headers.length === 0 ? NO_SOURCES : undefined),
  async run(ctx) {
    const bin = ctx.tools.cFormatter!;
    const files = [...ctx.sources, ...ctx.headers];
    // エディタに未保存の変更があるファイルは、ディスク上を書き換えると編集中の内容と食い違うので整形しない
    const dirty = files.filter((f) => ctx.isFileDirty?.(f));
    if (dirty.length > 0) {
      return {
        status: 'skip',
        diags: [],
        log: `未保存のファイル:\n${dirty.map((f) => `  ${path.relative(ctx.root, f)}`).join('\n')}\n`,
        reason: `未保存の変更があるファイルが ${dirty.length} 件あるため、整形しませんでした`,
        hint: '保存してから、もう一度実行してください',
      };
    }
    const before = new Map(files.map((f) => [f, fs.readFileSync(f)]));
    const rel = files.map((f) => path.relative(ctx.root, f));

    // c_formatter_42 は、80 桁を超える文字列リテラルの途中で改行するなど、コードを壊すことがある。
    // 整形の前に構文チェックが通っていたら、整形の後にも通ることを確かめ、通らなければ元に戻す。
    const baseline = await syntaxCheck(ctx);
    // c_formatter_42 は実行中、cwd の .clang-format を自分の設定へのシンボリックリンクに差し替え、終了時に元へ戻す。
    // 強制終了 (タイムアウト / 中止) されてもユーザーの .clang-format を失わないよう、空のディレクトリを cwd にして絶対パスで渡す。
    const cwd = path.join(ctx.workDir, 'format-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const r = await exec(bin, [...stepArgs(ctx, 'cFormatter'), ...files], { cwd, timeoutMs: staticMs(ctx), signal: ctx.signal });
    fs.rmSync(cwd, { recursive: true, force: true });

    // 失敗や中断のときも、書き換わってしまったファイルは退避する
    const changed = files.filter((f) => !before.get(f)!.equals(fs.readFileSync(f)));
    const backup = path.join(ctx.workDir, 'format-backup');
    for (const f of changed) {
      const dest = path.join(backup, path.relative(ctx.root, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, before.get(f)!);
    }
    const restoreAll = () => {
      for (const f of changed) fs.writeFileSync(f, before.get(f)!);
      fs.rmSync(backup, { recursive: true, force: true });
    };
    const list = (fs_: string[]) => fs_.map((f) => `  ${path.relative(ctx.root, f)}`).join('\n');
    let log = cmdline(bin, rel) + r.output.split(ctx.root + path.sep).join('');

    if (r.timedOut) {
      restoreAll();
      return { status: 'fail', diags: [], log, reason: '制限時間 (c42check.staticTimeoutSec) を超えました。整形は取り消しました' };
    }
    if (r.error || r.code !== 0) {
      restoreAll();
      return {
        status: 'fail',
        diags: [],
        log,
        reason: r.error ?? `c_formatter_42 が終了コード ${r.code} で終了しました。整形は取り消しました`,
      };
    }
    if (changed.length > 0 && baseline.checked && baseline.ok) {
      const after = await syntaxCheck(ctx);
      if (after.checked && !after.ok) {
        restoreAll();
        log += `整形後にコンパイルが通らなくなったため、変更した ${changed.length} 件を元に戻しました:\n${list(changed)}\n${after.output}`;
        return {
          status: 'fail',
          diags: after.diags,
          log,
          reason: `c_formatter_42 の整形でコードが壊れたため、元に戻しました (${changed.map((f) => path.basename(f)).join(', ')})`,
          hint: '80 桁を超える文字列リテラルは、c_formatter_42 が途中で改行して壊すことがあります。リテラルを手で分割する (隣り合う "..." "...") など、先に直してください。#include の並び順に依存したヘッダも壊れます',
        };
      }
    }
    log += changed.length
      ? `整形で変更したファイル ${changed.length} 件 (変更前は .42check/format-backup/ に退避):\n${list(changed)}\n`
      : '整形による変更はありません\n';
    if (!(baseline.checked && baseline.ok)) log += '(clang が無い、または整形前から構文エラーがあるため、整形後の構文チェックは行っていません)\n';
    return {
      status: 'pass',
      diags: [],
      log,
      reason: changed.length ? `${changed.length} ファイルを整形しました` : undefined,
    };
  },
};

/** 構文・型のチェックだけ (-fsyntax-only)。clang が無い / 対象が無い場合は checked: false。 */
async function syntaxCheck(ctx: Context): Promise<{ checked: boolean; ok: boolean; output: string; diags: Diag[] }> {
  const cc = ctx.tools.cc;
  if (!cc || ctx.sources.length === 0) return { checked: false, ok: false, output: '', diags: [] };
  const r = await exec(cc, ['-fsyntax-only', ...incFlags(ctx), ...extraCflags(ctx), ...ctx.sources], {
    cwd: ctx.root,
    timeoutMs: staticMs(ctx),
    signal: ctx.signal,
  });
  const diags = parseCompilerOutput(r.output, ctx.root, 'clang');
  return { checked: true, ok: r.code === 0 && !r.error, output: r.output, diags };
}

const norminette: StepDef = {
  id: 'norminette',
  label: 'norminette',
  stage: 1,
  prerequisite: (ctx) => first(needTool(ctx, 'norminette', 'norminette'), ctx.sources.length + ctx.headers.length === 0 ? NO_SOURCES : undefined),
  async run(ctx) {
    const files = [...ctx.sources, ...ctx.headers].map((f) => path.relative(ctx.root, f));
    const bin = ctx.tools.norminette!;
    const args = [...stepArgs(ctx, 'norminette'), ...files];
    const r = await exec(bin, args, { cwd: ctx.root, timeoutMs: staticMs(ctx), signal: ctx.signal });
    const diags = parseNorminette(r.output, ctx.root);
    const out = cmdline(bin, args) + stripAnsi(r.output);
    return verdict(r.code, diags, out, { error: r.error, timedOut: r.timedOut });
  },
};

const warnings: StepDef = {
  id: 'warnings',
  label: '警告強化ビルド',
  stage: 1,
  prerequisite: (ctx) => first(needTool(ctx, 'cc', 'clang'), noSources(ctx)),
  async run(ctx) {
    const cc = ctx.tools.cc!;
    const args = [
      '-fsyntax-only',
      ...normalizeArgs(ctx.settings.compileWarningFlags, ctx.root),
      ...incFlags(ctx),
      ...extraCflags(ctx),
      ...stepArgs(ctx, 'warnings'),
      ...ctx.sources,
    ];
    const r = await exec(cc, args, { cwd: ctx.root, timeoutMs: staticMs(ctx), signal: ctx.signal });
    const diags = parseCompilerOutput(r.output, ctx.root, 'clang');
    return verdict(r.code, diags, cmdline(cc, args) + r.output, { error: r.error, timedOut: r.timedOut });
  },
};

const clangTidy: StepDef = {
  id: 'clangTidy',
  label: 'clang-tidy',
  stage: 1,
  prerequisite: (ctx) => first(needTool(ctx, 'tidy', 'clang-tidy'), noSources(ctx)),
  async run(ctx) {
    const tidy = ctx.tools.tidy!;
    // 合否の正は clang-tidy。warning も fail にするため --warnings-as-errors='*' を付ける。
    const args = [
      `-checks=${ctx.settings.clangTidyChecks}`,
      '--warnings-as-errors=*',
      '--quiet',
      ...stepArgs(ctx, 'clangTidy'), // clang-tidy 自身のオプション (コンパイラへの引数は cflags)
      ...ctx.sources,
      '--',
      ...incFlags(ctx),
      ...extraCflags(ctx),
    ];
    const r = await exec(tidy, args, { cwd: ctx.root, timeoutMs: staticMs(ctx), signal: ctx.signal });
    const diags = parseCompilerOutput(r.output, ctx.root, 'clang-tidy');
    return verdict(r.code, diags, cmdline(tidy, args) + r.output, { error: r.error, timedOut: r.timedOut });
  },
};

const scanBuild: StepDef = {
  id: 'scanBuild',
  label: 'scan-build',
  stage: 1,
  prerequisite: (ctx) =>
    first(
      needTool(ctx, 'scanBuild', 'scan-build'),
      ctx.hasMakefile ? needTool(ctx, 'make', 'make') : needTool(ctx, 'cc', 'clang'),
      noSources(ctx),
    ),
  async run(ctx) {
    const sb = ctx.tools.scanBuild!;
    const base = path.join(ctx.workDir, 'scan-build');
    const copy = path.join(base, 'src');
    const reports = path.join(base, 'report');
    fs.mkdirSync(reports, { recursive: true });
    // 元のツリーに残った *.o で make がコンパイルを省略しないよう、きれいなコピーの中でビルドする
    copyProject(ctx.root, copy, ctx.settings.workDirMaxMB * 1024 * 1024);
    const map = (p: string) => (p.startsWith(copy + path.sep) ? path.join(ctx.root, path.relative(copy, p)) : p);

    let log = '';
    let output = '';
    let code: number | null = 0;
    let error: string | undefined;
    let timedOut = false;
    const run = async (args: string[], cwd: string) => {
      log += cmdline(sb, args);
      const r = await exec(sb, args, { cwd, timeoutMs: staticMs(ctx), signal: ctx.signal });
      log += r.output;
      output += r.output;
      if (r.code !== 0) code = r.code ?? 1;
      error ??= r.error;
      timedOut ||= r.timedOut;
    };

    const makefile = findMakefile(ctx.targetRoot);
    const targetCwd = path.join(copy, path.relative(ctx.root, ctx.targetRoot));
    if (makefile) {
      const target = ctx.settings.useMakeCheckTarget && makeTargetExists(makefile, 'check') ? ['check'] : [];
      // Makefile が CC を固定していても scan-build の ccc-analyzer が使われるよう、コマンドラインで CC を渡す
      await run(
        ['--status-bugs', '-o', reports, ...stepArgs(ctx, 'scanBuild'), 'sh', '-c', 'exec make -B CC="$CC" "$@"', 'sh', ...target],
        targetCwd,
      );
    } else {
      // Makefile が無ければ、.c を 1 つずつ ccc-analyzer でコンパイルする
      for (const file of ctx.sources) {
        const rel = path.join(copy, path.relative(ctx.root, file));
        await run(
          [
            '--status-bugs',
            '-o',
            reports,
            ...stepArgs(ctx, 'scanBuild'),
            'sh',
            '-c',
            'exec "$CC" "$@"',
            'sh',
            ...incFlags(ctx).map((f) => f.replace(ctx.root, copy)),
            ...extraCflags(ctx),
            '-c',
            rel,
            '-o',
            '/dev/null',
          ],
          copy,
        );
      }
    }
    const diags = parseCompilerOutput(output, copy, 'scan-build', map);
    return verdict(code, diags, log, { error, timedOut });
  },
};

const gccAnalyzer: StepDef = {
  id: 'gccAnalyzer',
  label: 'gcc -fanalyzer',
  stage: 1,
  prerequisite: (ctx) => first(needTool(ctx, 'gcc', 'gcc'), noSources(ctx)),
  async run(ctx) {
    const gcc = ctx.tools.gcc!;
    const outDir = path.join(ctx.workDir, 'gcc-analyzer');
    fs.mkdirSync(outDir, { recursive: true });
    // -fanalyzer は -fsyntax-only では動かないため、.o を作業ディレクトリに出力する
    const args = ['-fanalyzer', '-c', ...incFlags(ctx), ...extraCflags(ctx), ...stepArgs(ctx, 'gccAnalyzer'), ...ctx.sources];
    const r = await exec(gcc, args, { cwd: outDir, timeoutMs: staticMs(ctx), signal: ctx.signal });
    // gcc は analyzer の警告でも終了コード 0 になるため、-Wanalyzer-* の診断を error として扱う
    const diags = parseCompilerOutput(r.output, ctx.root, 'gcc-analyzer').map((d) =>
      d.message.includes('[-Wanalyzer-') ? { ...d, severity: 'error' as const } : d,
    );
    return verdict(r.code, dedupe(diags), cmdline(gcc, args) + r.output, { error: r.error, timedOut: r.timedOut });
  },
};

/* ───────────── 段階 2 ───────────── */

const runMs = (ctx: Context) => ctx.settings.runTimeoutSec * 1000;

interface SanitizerSpec {
  id: StepId;
  label: string;
  dir: string; // .42check/<dir>/prog (sanitizer 同士は併用できないので別ビルド)
  flags: string[];
  env: (detectLeaks: number) => NodeJS.ProcessEnv;
  /** 実行時出力にこれが現れたら「sanitizer が報告した」とみなす */
  reported: RegExp;
  /** valgrind 同様、sanitizer 付きは遅いので制限時間に掛ける倍率 */
  timeoutFactor: number;
  /** LeakSanitizer を使う (ptrace 制限環境では detect_leaks=0 で再実行する) */
  leaks?: boolean;
  /** 起動直後の SEGV で、プロジェクトのコードに原因が見つからないものを、環境の問題として skip にする (TSan / MSan) */
  startupCrashIsEnv?: boolean;
}

/**
 * sanitizer 付きのプログラムが、ユーザーのコードとは無関係に起動時に落ちたか。
 * - 報告も出さずに SEGV で終わった、または
 * - SEGV の報告があるが、スタックにプロジェクトのフレームが無く、sanitizer のランタイム内 (`__msan_init` など) で落ちている
 * TSan / MSan がカーネルの ASLR 設定などと合わない環境で起きる。ユーザーのコードが落ちた場合は、スタックにそのフレームが出る。
 */
export function isSanitizerStartupCrash(output: string, signal: string | null, hasProjectFrame: boolean): boolean {
  if (hasProjectFrame) return false;
  const segv = signal === 'SIGSEGV' || /DEADLYSIGNAL|SEGV on unknown address/.test(output);
  if (!segv) return false;
  const silent = !/Sanitizer/.test(output);
  const inRuntime = /__(?:msan|tsan)_init|\b(?:msan|tsan|__sanitizer|__tsan|__msan)::|libclang_rt\.(?:msan|tsan)/.test(output);
  return silent || inRuntime;
}

// sanitizer のランタイム (libclang_rt.*) が無い / このツールチェーンが未対応のとき。ユーザーのコードの問題ではない
const RUNTIME_MISSING = /libclang_rt\.[a-z_]+-[a-z0-9_]+\.a|unsupported option '-fsanitize|invalid argument '[^']*' to -fsanitize|unsupported option '-fsanitize/;
// TSan / MSan がカーネルの ASLR 設定などで起動できないとき (環境依存の既知の問題)
const CANNOT_START = /unexpected memory mapping|ThreadSanitizer: unsupported|MemorySanitizer: unsupported|FATAL: (Thread|Memory)Sanitizer: .*(mapping|ASLR)/i;

/** ASan+UBSan / TSan / MSan は、項目ごとに別ビルド・別実行にする (複数選択すると複数回に分けて実行される)。 */
function sanitizerStep(spec: SanitizerSpec): StepDef {
  return {
    id: spec.id,
    label: spec.label,
    stage: 2,
    prerequisite: (ctx) => first(needTool(ctx, 'cc', 'clang'), noSources(ctx), needMain(ctx)),
    async run(ctx) {
      const flags = ['-g', '-O1', '-fno-omit-frame-pointer', '-pthread', ...spec.flags];
      const b = await buildBinary(ctx, path.join(ctx.workDir, spec.dir), flags, 'clang', spec.id);
      if (!b.ok) {
        if (RUNTIME_MISSING.test(b.output)) {
          return {
            status: 'skip',
            diags: [],
            log: b.output,
            reason: `${spec.label} のランタイムが使えません (この clang が未対応、または libclang_rt が未導入)`,
            hint: 'clang の sanitizer ランタイム (Ubuntu: libclang-rt-<版>-dev、Arch: compiler-rt) が必要です。sudo の無い校舎では、この項目のチェックを外してください',
          };
        }
        return { status: 'fail', diags: b.diags, log: b.output, reason: `${spec.label} 用のビルドに失敗しました` };
      }
      const timeoutMs = runMs(ctx) * spec.timeoutFactor;
      const runWith = (detectLeaks: number) =>
        exec(b.bin, ctx.settings.runArgs, {
          cwd: ctx.root,
          timeoutMs,
          signal: ctx.signal,
          env: { ...process.env, ...spec.env(detectLeaks) },
        });
      let r = await runWith(1);
      let log = b.output + `$ ${b.bin} ${ctx.settings.runArgs.join(' ')}\n`;
      if (spec.leaks && /LeakSanitizer has encountered a fatal error|LeakSanitizer does not work under ptrace/.test(r.output)) {
        log += r.output + '\n[c42check] この環境では LeakSanitizer が使えないため、リーク検査なしで再実行します (リークは valgrind 側で確認してください)\n';
        r = await runWith(0);
      }
      log += r.output;
      if (CANNOT_START.test(r.output)) {
        return {
          status: 'skip',
          diags: [],
          log,
          reason: `${spec.label} がこの環境で起動できませんでした (メモリマップ / ASLR 設定が原因の既知の問題の可能性)`,
          hint: 'カーネルの vm.mmap_rnd_bits が大きいと起動できないことがあります (`sudo sysctl vm.mmap_rnd_bits=28` で回避できる場合がありますが、sudo の無い校舎では不可)。その場合はこの項目のチェックを外してください',
        };
      }
      const diags = parseSanitizer(r.output, ctx.root);
      if (spec.startupCrashIsEnv && isSanitizerStartupCrash(r.output, r.signal, diags.length > 0)) {
        return {
          status: 'skip',
          diags: [],
          log,
          reason: `${spec.label} 付きのプログラムが、起動時に落ちました (プロジェクトのコードには原因が見つからず、この環境では使えない可能性が高い)`,
          hint: 'カーネルの ASLR 設定 (vm.mmap_rnd_bits) や clang の版との組み合わせで起きることがあります。ログの先頭を確認し、校舎などで使えない場合はこの項目のチェックを外してください',
        };
      }
      if (r.timedOut) {
        return {
          status: 'skip',
          diags: [],
          log,
          reason: `制限時間 ${timeoutMs / 1000} 秒で中断したため検査が完了していません`,
          hint: '`c42check.runTimeoutSec` を延ばす、`c42check.runArgs` で終了する引数を渡す、または GUI / 無限ループの課題ならこの項目のチェックを外してください',
        };
      }
      const reported = spec.reported.test(r.output);
      const crashed = r.signal !== null;
      const failed = reported || crashed || !!r.error;
      return {
        status: failed ? 'fail' : 'pass',
        diags,
        log,
        reason: failed
          ? r.error ?? (reported ? `${spec.label} が問題を報告しました` : `シグナル ${r.signal} で終了しました`)
          : undefined,
      };
    },
  };
}

const asanUbsan = sanitizerStep({
  id: 'asanUbsan',
  label: 'ASan + UBSan',
  dir: 'asan',
  flags: ['-fsanitize=address,undefined', '-fno-sanitize-recover=undefined'],
  env: (leaks) => ({ ASAN_OPTIONS: `detect_leaks=${leaks}:color=never`, UBSAN_OPTIONS: 'print_stacktrace=1:color=never' }),
  reported: /ERROR: (Address|Leak)Sanitizer|runtime error:/,
  timeoutFactor: 1,
  leaks: true,
});

const tsan = sanitizerStep({
  id: 'tsan',
  label: 'TSan',
  dir: 'tsan',
  flags: ['-fsanitize=thread'],
  env: () => ({ TSAN_OPTIONS: 'color=never' }),
  reported: /WARNING: ThreadSanitizer/,
  timeoutFactor: 3,
  startupCrashIsEnv: true,
});

const msan = sanitizerStep({
  id: 'msan',
  label: 'MSan',
  dir: 'msan',
  // MSan は clang 専用。未初期化値の発生元を出すため origins を追跡する
  flags: ['-fsanitize=memory', '-fsanitize-memory-track-origins'],
  env: () => ({ MSAN_OPTIONS: 'color=never' }),
  reported: /WARNING: MemorySanitizer/,
  timeoutFactor: 3,
  startupCrashIsEnv: true,
});

const valgrind: StepDef = {
  id: 'valgrind',
  label: 'valgrind',
  stage: 2,
  prerequisite: (ctx) => first(needTool(ctx, 'valgrind', 'valgrind'), needTool(ctx, 'cc', 'clang'), noSources(ctx), needMain(ctx)),
  async run(ctx) {
    const b = await buildBinary(ctx, path.join(ctx.workDir, 'valgrind'), ['-g', '-O0', '-fno-omit-frame-pointer'], 'clang');
    if (!b.ok) {
      return { status: 'fail', diags: b.diags, log: b.output, reason: 'valgrind 用のビルドに失敗しました' };
    }
    const EXIT = 99;
    const args = [
      ...normalizeArgs(ctx.settings.valgrindArgs, ctx.root), // 既定: --leak-check=full --show-leak-kinds=all --track-fds=yes
      `--error-exitcode=${EXIT}`, // 判定に必要なので、設定では外せない
      '--fullpath-after=',
      ...stepArgs(ctx, 'valgrind'), // valgrind 自身のオプション (コンパイラへの引数は cflags / ldflags / libs)
      b.bin,
      ...ctx.settings.runArgs,
    ];
    const r = await exec(ctx.tools.valgrind!, args, {
      cwd: ctx.root,
      timeoutMs: runMs(ctx) * 5,
      signal: ctx.signal,
    });
    const log = b.output + cmdline('valgrind', args) + r.output;
    if (r.timedOut) {
      return {
        status: 'skip',
        diags: [],
        log,
        reason: `制限時間 ${ctx.settings.runTimeoutSec * 5} 秒で中断したため検査が完了していません`,
        hint: '`c42check.runTimeoutSec` を延ばす、`c42check.runArgs` で終了する引数を渡す、または GUI / 無限ループの課題ならこの項目のチェックを外してください',
      };
    }
    const parsed = parseValgrind(r.output, ctx.root);
    const failed = r.code === EXIT || parsed.fdLeaks > 0 || !!r.error;
    return {
      status: failed ? 'fail' : 'pass',
      diags: parsed.diags,
      log,
      reason: failed
        ? r.error ?? (r.code === EXIT ? 'valgrind がエラーを報告しました' : `閉じられていない file descriptor が ${parsed.fdLeaks} 件あります`)
        : undefined,
    };
  },
};

const cbmc: StepDef = {
  id: 'cbmc',
  label: 'CBMC (任意)',
  stage: 2,
  prerequisite: (ctx) => first(needTool(ctx, 'cbmc', 'cbmc'), noSources(ctx), needMain(ctx)),
  async run(ctx) {
    const args = [
      ...buildInputs(ctx).files,
      ...incFlags(ctx),
      '--bounds-check',
      '--pointer-check',
      '--signed-overflow-check',
      '--unwind',
      '8',
      ...stepArgs(ctx, 'cbmc'),
    ];
    const r = await exec(ctx.tools.cbmc!, args, { cwd: ctx.root, timeoutMs: staticMs(ctx), signal: ctx.signal });
    const diags = parseCbmc(r.output, ctx.root);
    // cbmc: 0 = 検証成功 / 10 = 反例あり / その他 = ツールの失敗
    return verdict(r.code, diags, cmdline('cbmc', args) + r.output, { error: r.error, timedOut: r.timedOut });
  },
};

const framaC: StepDef = {
  id: 'framaC',
  label: 'Frama-C Eva (任意)',
  stage: 2,
  prerequisite: (ctx) => first(needTool(ctx, 'framaC', 'frama-c'), noSources(ctx), needMain(ctx)),
  async run(ctx) {
    const args = ['-eva', '-eva-precision', '1', ...incFlags(ctx).map((f) => `-cpp-extra-args=${f}`), ...stepArgs(ctx, 'framaC'), ...buildInputs(ctx).files];
    const r = await exec(ctx.tools.framaC!, args, { cwd: ctx.root, timeoutMs: staticMs(ctx), signal: ctx.signal });
    const diags = parseFramaC(r.output, ctx.root);
    return verdict(r.code, diags, cmdline('frama-c', args) + r.output, { error: r.error, timedOut: r.timedOut });
  },
};

/** 実行順 (段階 1 → 段階 2、段階内は宣言順)。 */
export const STEPS: StepDef[] = [cFormatter, norminette, warnings, clangTidy, scanBuild, gccAnalyzer, asanUbsan, tsan, msan, valgrind, cbmc, framaC];

export function stepById(id: StepId): StepDef {
  const s = STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown step: ${id}`);
  return s;
}
