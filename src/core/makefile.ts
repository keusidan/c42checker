/**
 * Norm v4.1 III.11 "Makefile" の規則の検査。Makefile は norminette が検査せず、評価で人が確かめる (Norm 本文より)。
 *
 * 静的に Makefile の中身を読む部分と、プロジェクトのコピーで実際に make を動かす部分がある (元のファイルは変えない)。
 *  - `$(NAME)` `all` `clean` `fclean` `re` の規則がある
 *  - `all` が既定の規則 (make だけで動く)  … make -p の .DEFAULT_GOAL で確かめる
 *  - 2 回目の make で何も再ビルドされない (relink しない) … 1 回目と 2 回目の間でファイルの更新時刻が変わらないことで確かめる
 *  - ソースファイルを明示している (wildcard や *.c を使わない)
 *  - 同梱のライブラリ (libft など) を Makefile が自動でビルドする
 *  - clean / fclean / re が動く (clean で .o が消え、fclean で成果物が全て消える)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from './exec';
import { copyProject } from './workdir';
import type { Context, Diag } from './types';

export interface MakefileFinding {
  line: number;
  strength: 'error' | 'review';
  message: string;
}

/** コメントを除き、行継続 (\) をつなぐ。行番号は最初の行のものを持つ。 */
export function logicalLines(text: string): { line: number; text: string; recipe: boolean }[] {
  const raw = text.split('\n');
  const out: { line: number; text: string; recipe: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    let cur = raw[i].replace(/\r$/, '');
    const start = i + 1;
    while (cur.endsWith('\\') && i + 1 < raw.length) cur = cur.slice(0, -1) + ' ' + raw[++i].replace(/\r$/, '');
    const recipe = cur.startsWith('\t');
    const t = cur.replace(/(^|[^\\$])#.*$/, '$1');
    if (t.trim() !== '') out.push({ line: start, text: t, recipe });
  }
  return out;
}

/** 規則の目標名 (a b: deps → a, b) を集める。`:=` などの代入は除く。 */
export function ruleTargets(lines: { text: string; recipe: boolean }[]): string[] {
  const targets: string[] = [];
  for (const l of lines) {
    if (l.recipe) continue;
    const m = /^([^:=#\s][^:=#]*?)\s*:(?![:=])(?!=)/.exec(l.text) ?? /^([^:=#\s][^:=#]*?)\s*::(?!=)/.exec(l.text);
    if (!m) continue;
    for (const t of m[1].split(/\s+/)) if (t) targets.push(t);
  }
  return targets;
}

const norm = (t: string) => t.replace(/^\$\{(\w+)\}$/, '$($1)');

export function checkMakefileText(text: string, makefileDir: string): MakefileFinding[] {
  const lines = logicalLines(text);
  const out: MakefileFinding[] = [];
  const targets = ruleTargets(lines).map(norm);
  const add = (line: number, strength: 'error' | 'review', message: string) => out.push({ line, strength, message });

  const nameDefined = lines.some((l) => !l.recipe && /^NAME\s*[:?+]*=/.test(l.text));
  if (!nameDefined) add(1, 'error', '変数 NAME が定義されていません。`$(NAME)` の規則は必須です (Norm III.11)');
  for (const t of ['$(NAME)', 'all', 'clean', 'fclean', 're']) {
    if (!targets.includes(t)) add(1, 'error', `規則 ${t} がありません。$(NAME)、all、clean、fclean、re の規則は必須です (Norm III.11)`);
  }

  // ソースの明示: wildcard / find / *.c は禁止 (clean の rm に書く *.o は除く)
  for (const l of lines) {
    if (/^\s*#/.test(l.text)) continue;
    const isRemoval = /\brm\b|-delete\b/.test(l.text);
    if (/\bwildcard\b/.test(l.text) || /\$\(shell\s+(find|ls)\b/.test(l.text) || (/\*\.[co]\b/.test(l.text) && !isRemoval)) {
      add(l.line, 'error', 'ソースファイルを wildcard や `*.c` で指定しています。コンパイルに必要な全てのソースは、Makefile に明示的に書きます (Norm III.11)');
    }
  }

  // 同梱のライブラリを自動でビルドしているか
  const joined = lines.map((l) => l.text).join('\n');
  const libDirs = new Set<string>();
  for (const m of joined.matchAll(/-L\s*([^\s"']+)/g)) libDirs.add(m[1]);
  for (const dir of libDirs) {
    if (/\$[({]/.test(dir)) continue; // 変数を含むパスは、ここでは追わない
    const abs = path.resolve(makefileDir, dir);
    const hasMake = ['Makefile', 'makefile', 'GNUmakefile'].some((n) => fs.existsSync(path.join(abs, n)));
    if (!hasMake) continue;
    const d = dir.replace(/^\.\//, '').replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const built = new RegExp(`(-C\\s*(\\./)?${d}/?(?![\\w./-]))|(cd\\s+(\\./)?${d}(?![\\w./-]))`).test(joined);
    if (!built) {
      add(1, 'error', `同梱のライブラリ ${dir} (Makefile があります) を、この Makefile が自動でビルドしていません。\`$(MAKE) -C ${dir}\` などで、ビルドさせてください (Norm III.11)`);
    }
  }
  return out;
}

interface Snapshot {
  files: Map<string, bigint>;
}

function snapshot(dir: string): Snapshot {
  const files = new Map<string, bigint>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) files.set(path.relative(dir, f), fs.statSync(f, { bigint: true }).mtimeNs);
    }
  };
  walk(dir);
  return { files };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tail = (s: string, n = 1500) => (s.length > n ? '…' + s.slice(-n) : s);

export interface MakefileRun {
  findings: MakefileFinding[];
  log: string;
  /** make が使えず動的な検査ができなかった / 中断 / 制限時間 */
  note?: string;
}

export async function checkMakefile(ctx: Context, makefile: string): Promise<MakefileRun> {
  const makefileDir = path.dirname(makefile);
  const text = fs.readFileSync(makefile, 'utf8');
  const findings = checkMakefileText(text, makefileDir);
  let log = `Makefile: ${path.relative(ctx.root, makefile)}\n`;
  const make = ctx.tools.make;
  if (!make) return { findings, log, note: 'make が無いため、動かす検査 (既定の規則・relink・clean / fclean / re) は行っていません' };

  const work = path.join(ctx.workDir, 'makefile-check');
  fs.rmSync(work, { recursive: true, force: true });
  const copyRoot = path.join(work, 'tree');
  try {
    copyProject(ctx.root, copyRoot, ctx.settings.workDirMaxMB * 1048576);
  } catch (e) {
    return { findings, log, note: `プロジェクトをコピーできなかったため、動かす検査は行っていません: ${(e as Error).message}` };
  }
  const cwd = path.join(copyRoot, path.relative(ctx.root, makefileDir));
  const timeoutMs = ctx.settings.staticTimeoutSec * 1000;
  const run = async (args: string[]) => {
    const r = await exec(make, args, { cwd, timeoutMs, signal: ctx.signal });
    log += `$ make${args.length ? ' ' + args.join(' ') : ''}  (終了コード ${r.code})\n${tail(r.output)}\n`;
    return r;
  };
  const add = (strength: 'error' | 'review', message: string) => findings.push({ line: 1, strength, message });

  try {
    // 既定の規則
    const db = await exec(make, ['-p', '-n', '-q'], { cwd, timeoutMs, signal: ctx.signal, maxBytes: 8 * 1024 * 1024 });
    const goal = /^\.DEFAULT_GOAL\s*:=\s*(\S+)/m.exec(db.output)?.[1];
    if (goal && goal !== 'all') add('error', `make だけで実行される規則が all ではなく ${goal} です。all の規則を最初に書いてください (Norm III.11)`);

    const before = snapshot(cwd);
    const first = await run([]);
    if (first.timedOut || ctx.signal?.aborted) return { findings, log, note: '制限時間または中断のため、動かす検査を打ち切りました' };
    if (first.code !== 0) {
      add('error', `make が失敗しました (終了コード ${first.code})。ビルドが通らないので、以降の Makefile の検査はできません`);
      return { findings, log };
    }
    const built = snapshot(cwd);
    await sleep(150); // 更新時刻 (ナノ秒) がカーネルの時計の刻み (数 ms) より確実に進むだけ空ける。再ビルドされたファイルを見分けるため
    const second = await run([]);
    const after = snapshot(cwd);
    const changed = [...after.files].filter(([f, t]) => built.files.get(f) !== t).map(([f]) => f);
    const created = [...after.files.keys()].filter((f) => !built.files.has(f));
    if (changed.length + created.length > 0 || second.code !== 0) {
      add(
        'error',
        `2 回目の make で、再コンパイル / 再リンクが起きました (relink): ${[...changed, ...created].slice(0, 5).join(', ')}${changed.length + created.length > 5 ? ' ほか' : ''}。何も変えていないときは何もしないようにします (Norm III.11)`,
      );
    }

    const clean = await run(['clean']);
    if (clean.code !== 0) add('error', `make clean が失敗しました (終了コード ${clean.code})`);
    else {
      const leftovers = [...snapshot(cwd).files.keys()].filter((f) => f.endsWith('.o'));
      if (leftovers.length > 0) add('error', `make clean の後にオブジェクトファイルが残っています: ${leftovers.slice(0, 5).join(', ')}`);
    }
    const fclean = await run(['fclean']);
    if (fclean.code !== 0) add('error', `make fclean が失敗しました (終了コード ${fclean.code})`);
    else {
      const left = [...snapshot(cwd).files.keys()].filter((f) => !before.files.has(f));
      if (left.length > 0) add('error', `make fclean の後にビルドの成果物が残っています: ${left.slice(0, 5).join(', ')}`);
    }
    const re = await run(['re']);
    if (re.code !== 0) add('error', `make re が失敗しました (終了コード ${re.code})`);
    return { findings, log };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function toDiags(makefile: string, findings: MakefileFinding[]): Diag[] {
  return findings.map((f) => ({
    file: makefile,
    line: f.line,
    col: 1,
    severity: f.strength === 'error' ? 'error' : 'warning',
    message: `[makefile] ${f.message}`,
    source: 'makefile',
  }));
}
