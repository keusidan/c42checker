/**
 * 「使っていないヘッダの include は禁止」(Norm III.5 の (*)) を、コンパイラで確かめる。
 *
 * include を 1 行ずつ外して構文チェック (-fsyntax-only) をやり直し、**診断 (warning / error) が増えなければ、その include は使われていない**。
 * 名前の表を持たないので、どのヘッダ (mlx.h や readline など) でも判定できる。型・マクロ・定数・static inline も、コンパイラが必要としたかどうかで決まる。
 *
 * 元のファイルは書き換えない。プロジェクトのコピーの中で、include の行を空行に置き換える (行数が変わらないので診断の位置を比べられる)。
 *  - .c: そのファイルを構文チェックする
 *  - .h: そのヘッダだけを include する小さな .c と、そのヘッダを直接 include している .c を構文チェックする
 *
 * 取りこぼし: マクロの有無で挙動が変わるだけ (#ifdef) の include は、外しても診断が変わらないので、未使用と判定される。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from './exec';
import type { Finding, IncludeRef } from './normextra';
import type { Context } from './types';
import { copyProject } from './workdir';

export interface IncludeCheckInput {
  ctx: Context;
  /** 判定する .c / .h (normExclude を除いたもの) */
  files: string[];
  includesOf(file: string): IncludeRef[];
  /** そのヘッダを直接 include している .c (絶対パス) */
  includersOf(header: string): string[];
  /** コンパイラに渡す引数 (-I と設定の cflags)。元のプロジェクトの絶対パスで渡す */
  flags: string[];
}

export interface IncludeCheckResult {
  /** コンパイラで判定できたファイル (表による判定は不要) */
  judged: Set<string>;
  findings: Finding[];
  log: string;
}

const DIAG_RE = /^(.+?):(\d+):(\d+): (warning|error|fatal error): (.*)$/gm;
const BASE_FLAGS = ['-fsyntax-only', '-fno-color-diagnostics', '-fno-caret-diagnostics', '-ferror-limit=0', '-Wall', '-Wextra', '-Wundef', '-Wmissing-prototypes', '-Wmissing-variable-declarations'];
// -Wmissing-prototypes / -Wmissing-variable-declarations: 自分の .h を外すと「プロトタイプが無い」警告が出る = その .h は使われている (.c が自分のヘッダを include するのは普通)

type Diags = Map<string, number>;

function parseDiags(output: string): { diags: Diags; fatal: boolean } {
  const diags: Diags = new Map();
  let fatal = false;
  for (const m of output.matchAll(DIAG_RE)) {
    if (m[4] === 'fatal error') fatal = true;
    const key = `${m[1]}:${m[2]}:${m[3]}:${m[4]}:${m[5]}`;
    diags.set(key, (diags.get(key) ?? 0) + 1);
  }
  return { diags, fatal };
}

/** variant に、base にない (または base より多い) 診断があるか */
function hasNew(base: Diags, variant: Diags): boolean {
  for (const [k, n] of variant) if (n > (base.get(k) ?? 0)) return true;
  return false;
}

const blankLines = (text: string, lines: ReadonlySet<number>): string =>
  text
    .split('\n')
    .map((l, i) => (lines.has(i + 1) ? '' : l))
    .join('\n');

/** 同時に走らせるコンパイラの数 */
function parallelism(): number {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, n));
}

export async function judgeIncludes(input: IncludeCheckInput): Promise<IncludeCheckResult> {
  const { ctx } = input;
  const result: IncludeCheckResult = { judged: new Set(), findings: [], log: '' };
  const cc = ctx.tools.cc;
  if (!cc) return { ...result, log: '(clang が無いため、コンパイラによる include の判定は行いません)\n' };

  // コンパイラで確かめる必要があるのは、名前の表 / ctags では「使っているか分からない・使っていない」と見えた include だけ。
  // 使っていると分かる include は、コンパイルしない (ほとんどの include はこちら)
  const suspects = new Map<string, IncludeRef[]>();
  for (const file of input.files) {
    const cands = input.includesOf(file).filter((i) => !i.justified);
    if (cands.length === 0) result.judged.add(file);
    else suspects.set(file, cands);
  }
  if (suspects.size === 0) {
    return { ...result, log: `(include の判定: 全ての include が使われているのを、名前から確認できたので、コンパイルは不要でした)\n` };
  }

  const work = path.join(ctx.workDir, 'include-check');
  fs.rmSync(work, { recursive: true, force: true });
  const copyRoot = path.join(work, 'tree');
  try {
    copyProject(ctx.root, copyRoot, ctx.settings.workDirMaxMB * 1048576);
  } catch (e) {
    return { judged: new Set(), findings: [], log: `(プロジェクトをコピーできなかったため、コンパイラによる include の判定は行いません: ${(e as Error).message})\n` };
  }
  const toCopy = (p: string) => p.split(ctx.root).join(copyRoot); // 元のプロジェクトの絶対パスを、コピーのものに直す
  const flags = input.flags.map(toCopy);
  const timeoutMs = ctx.settings.staticTimeoutSec * 1000;
  const deadline = Date.now() + timeoutMs * 3;
  let compiles = 0;
  let aborted: string | undefined;

  const compile = async (unit: string): Promise<{ diags: Diags; fatal: boolean }> => {
    compiles++;
    const r = await exec(cc, [...BASE_FLAGS, ...flags, unit], { cwd: copyRoot, timeoutMs, signal: ctx.signal });
    if (r.timedOut || r.error || ctx.signal?.aborted) aborted = r.error ?? (r.timedOut ? '制限時間を超えました' : '中止されました');
    return parseDiags(r.output.split(copyRoot).join(''));
  };

  let stubSeq = 0;
  const processFile = async (file: string, cands: IncludeRef[]): Promise<void> => {
    if (aborted || Date.now() > deadline) {
      aborted ??= '時間切れ';
      return;
    }
    const rel = path.relative(ctx.root, file);
    const copyFile = path.join(copyRoot, rel);
    const original = fs.readFileSync(copyFile, 'utf8');
    // 判定に使うコンパイルの単位。.c はそのファイル自身。.h は、そのヘッダだけを include する小さな .c (先頭) と、そのヘッダを使う .c
    const units: string[] = [];
    if (file.endsWith('.h')) {
      const stub = path.join(copyRoot, `.c42check-stub-${stubSeq++}.c`);
      fs.writeFileSync(stub, `#include "${copyFile}"\n`);
      units.push(stub, ...input.includersOf(file).map((f) => path.join(copyRoot, path.relative(ctx.root, f))));
    } else units.push(copyFile);

    // 外す前の診断は、単位ごとに、必要になったときに 1 度だけ取る (先頭の単位で「必要」と分かれば、他の単位はコンパイルしない)
    const baseOf = new Map<string, { diags: Diags; fatal: boolean }>();
    const baseline = async (unit: string) => {
      if (!baseOf.has(unit)) baseOf.set(unit, await compile(unit));
      return baseOf.get(unit)!;
    };
    /** remove の行を外したとき、診断が増えないか (増えた単位が 1 つでもあれば、すぐ false) */
    const ok = async (remove: Set<number>): Promise<boolean> => {
      try {
        for (const u of units) {
          // 外す前の診断は、元のファイルのまま取る (単位ごとに 1 度だけ)
          if (!baseOf.has(u)) {
            fs.writeFileSync(copyFile, original);
            await baseline(u);
          }
          fs.writeFileSync(copyFile, blankLines(original, remove));
          const base = await baseline(u);
          if (aborted) return false;
          if (base.fatal) continue; // 外す前から fatal error の単位 (include 元の .c など) は、判定に使えない
          if (hasNew(base.diags, (await compile(u)).diags)) return false;
          if (aborted) return false;
        }
        return true;
      } finally {
        fs.writeFileSync(copyFile, original);
      }
    };

    const first = await baseline(units[0]);
    if (aborted) return;
    if (first.fatal) {
      result.log += `${rel}: 外す前の構文チェックが fatal error で止まるため、コンパイラでは判定しません (表による判定に切り替えます)\n`;
      return;
    }

    // 1 行ずつ外して、診断が増えないもの = 単独では外せる include
    const removable: IncludeRef[] = [];
    for (const c of cands) if (await ok(new Set([c.line]))) removable.push(c);
    if (aborted) return;
    if (removable.length === 0) {
      result.judged.add(file);
      return;
    }
    // 外せるものを全部まとめて外しても診断が増えなければ、どれも本当に未使用。
    // 増えるなら、同じ名前を提供する include が重なっている (どれか 1 つは必要)
    const all = new Set(removable.map((c) => c.line));
    const unused = new Set<number>(removable.map((c) => c.line));
    const ambiguous = new Set<number>();
    if (removable.length > 1 && !(await ok(all))) {
      // 先頭から順に外していき、外せなくなったもの (blocked) と、それと重なっているもの (外し済みのうち、戻すと blocked が外せるもの) を ambiguous にする
      const removed = new Set<number>();
      const blocked: number[] = [];
      for (const c of removable) {
        const next = new Set([...removed, c.line]);
        if (await ok(next)) removed.add(c.line);
        else blocked.push(c.line);
      }
      if (aborted) return;
      for (const b of blocked) ambiguous.add(b);
      for (const g of removed) {
        const without = new Set([...removed, ...blocked].filter((l) => l !== g));
        if (blocked.length > 0 && (await ok(without))) ambiguous.add(g);
      }
      for (const l of ambiguous) unused.delete(l);
    }
    if (aborted) return;
    for (const c of removable) {
      const label = c.system ? `<${c.name}>` : `"${c.name}"`;
      if (unused.has(c.line)) {
        result.findings.push({
          file,
          line: c.line,
          rule: 'unused-include',
          strength: 'error',
          message: `#include ${label} が使われていません (この行を外しても、コンパイルの診断が増えません)。使っていないヘッダの include は禁止です。理由があるなら、その行にコメントで書いてください (Norm III.5)`,
        });
      } else {
        const partners = removable.filter((o) => o.line !== c.line && ambiguous.has(o.line)).map((o) => (o.system ? `<${o.name}>` : `"${o.name}"`));
        result.findings.push({
          file,
          line: c.line,
          rule: 'unused-include',
          strength: 'review',
          message: `#include ${label} は、外してもコンパイルが通ります。ただし ${partners.join(', ') || '別の include'} と提供する名前が重なっていて、どれか 1 つは必要です。使う名前を提供する方だけ残してください (Norm III.5)`,
        });
      }
    }
    result.judged.add(file);
  };

  try {
    // .c は、それぞれ自分のコピーだけを書き換えるので、並列に判定できる。.h は他のファイルのコンパイルに影響するので、1 つずつ判定する
    const cFiles = [...suspects].filter(([f]) => !f.endsWith('.h'));
    const hFiles = [...suspects].filter(([f]) => f.endsWith('.h'));
    const queue = [...cFiles];
    const workers = Array.from({ length: Math.min(parallelism(), queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await processFile(next[0], next[1]);
    });
    await Promise.all(workers);
    for (const [file, cands] of hFiles) await processFile(file, cands);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  result.log += `(コンパイラによる include の判定: 確かめた include のあるファイル ${suspects.size} 件、構文チェック ${compiles} 回${aborted ? `。${aborted}のため途中で打ち切り、残りは表による判定に切り替えました` : ''})\n`;
  return result;
}
