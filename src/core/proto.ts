import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveCtags, runCtags, type CtagsFunction } from './ctags';
import { exec } from './exec';
import { parseNorminette, stripAnsi } from './parse';
import { scanSources } from './sources';
import type { Context, Diag } from './types';

export const MARKER_BEGIN = '/* ---- auto prototypes begin ---- */';
export const MARKER_END = '/* ---- auto prototypes end ---- */';

const TAB_WIDTH = 4;
const MAX_COLUMNS = 80;

/* ───────────── ctags の出力 → 42 Norm の宣言 ───────────── */

export interface ReturnType {
  base: string; // 例: `char` / `unsigned long long` / `struct s_list`
  stars: string; // 例: `` / `*` / `**`  (42 Norm では関数名側に寄せる)
}

/**
 * ctags の typeref (`typename:char *`、`struct:s_list *` など) を、基底の型とポインタに分ける。
 * 関数ポインタを返す関数など、norm 形式に素直に直せないものは undefined。
 */
export function normalizeReturnType(typeref: string | undefined): ReturnType | undefined {
  if (!typeref) return undefined;
  const m = /^(typename|struct|union|enum):(.*)$/.exec(typeref.trim());
  if (!m) return undefined;
  let t = m[2].replace(/\s+/g, ' ').trim();
  if (m[1] !== 'typename') t = `${m[1]} ${t}`;
  t = t.replace(/\*\s+(?=\*)/g, '*');
  if (/[()[\]]/.test(t) || /\*\s*\w/.test(t)) return undefined; // 関数ポインタ / 配列 / `char *const` など
  const mm = /^([^*]+?)\s*(\*+)?$/.exec(t);
  if (!mm) return undefined;
  return { base: mm[1].trim(), stars: mm[2] ?? '' };
}

/** 括弧の深さを見て、トップレベルのカンマで分割する。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * ctags の signature (`(const char * s,void * (* f)(void *))`) を、norm 形式
 * (`(const char *s, void *(*f)(void *))`) に整える。引数なしは `(void)`。
 */
export function normalizeParams(signature: string | undefined): string | undefined {
  if (signature === undefined) return undefined;
  const sig = signature.trim();
  if (!sig.startsWith('(') || !sig.endsWith(')')) return undefined;
  const inner = sig.slice(1, -1).trim();
  if (inner === '') return '(void)';
  const params = splitTopLevel(inner).map((p) =>
    p
      .replace(/\s+/g, ' ')
      .trim()
      // ポインタの `*` は直後の名前 / `(` / `*` に寄せる: `char * s` → `char *s`、`void * (* f)` → `void *(*f)`
      .replace(/\*\s+(?=[A-Za-z_(*])/g, '*')
      .replace(/\(\s+/g, '(')
      .replace(/\s*,\s*/g, ', '),
  );
  if (params.some((p) => p === '')) return undefined;
  return `(${params.join(', ')})`;
}

export interface ProtoEntry {
  name: string;
  file: string;
  base: string;
  stars: string;
  params: string;
}

export interface Unsupported {
  name: string;
  file: string;
  line: number;
  reason: string;
}

export interface BuiltPrototypes {
  entries: ProtoEntry[];
  unsupported: Unsupported[];
  /** static と main など、意図して除外した件数 */
  excluded: number;
}

/** static 関数と main を除き、同名は最初の定義だけを採り、宣言に直せないものは unsupported に集める。 */
export function buildEntries(funcs: CtagsFunction[]): BuiltPrototypes {
  const entries: ProtoEntry[] = [];
  const unsupported: Unsupported[] = [];
  const seen = new Set<string>();
  let excluded = 0;
  for (const f of funcs) {
    if (f.isStatic || f.name === 'main') {
      excluded++;
      continue;
    }
    if (seen.has(f.name)) continue; // #ifdef で同名の定義が複数あるとき
    seen.add(f.name);
    const rt = normalizeReturnType(f.typeref);
    const params = normalizeParams(f.signature);
    if (!rt || params === undefined) {
      unsupported.push({
        name: f.name,
        file: f.file,
        line: f.line,
        reason: !rt ? `戻り値の型を宣言に直せません (typeref: ${f.typeref ?? '(なし)'})` : `引数を宣言に直せません (signature: ${f.signature ?? '(なし)'})`,
      });
      continue;
    }
    entries.push({ name: f.name, file: f.file, base: rt.base, stars: rt.stars, params });
  }
  return { entries, unsupported, excluded };
}

const visualWidth = (s: string): number => {
  let w = 0;
  for (const c of s) w = c === '\t' ? (Math.floor(w / TAB_WIDTH) + 1) * TAB_WIDTH : w + 1;
  return w;
};

export interface RenderedBlock {
  /** マーカーの内側の行 (マーカー自体は含まない) */
  lines: string[];
  /** 80 桁を超える宣言 (norm 違反になる) */
  tooLong: string[];
}

/**
 * 42 Norm の形式で出力する。戻り値の型の後ろはタブ、`*` は関数名側に寄せ、
 * 関数名の桁を全体で揃える (MISALIGNED_FUNC_DECL 対策)。ファイルごとにコメントで区切る。
 */
export function renderBlock(entries: ProtoEntry[], baseDir: string): RenderedBlock {
  const maxBase = entries.reduce((m, e) => Math.max(m, visualWidth(e.base)), 0);
  const nameCol = (Math.floor(maxBase / TAB_WIDTH) + 1) * TAB_WIDTH;
  const lines: string[] = [];
  const tooLong: string[] = [];
  let currentFile: string | undefined;
  for (const e of entries) {
    if (e.file !== currentFile) {
      if (currentFile !== undefined) lines.push('');
      lines.push(`/* ${path.relative(baseDir, e.file).split(path.sep).join('/')} */`);
      currentFile = e.file;
    }
    const tabs = '\t'.repeat(Math.ceil((nameCol - visualWidth(e.base)) / TAB_WIDTH));
    const line = `${e.base}${tabs}${e.stars}${e.name}${e.params};`;
    if (visualWidth(line) > MAX_COLUMNS) tooLong.push(e.name);
    lines.push(line);
  }
  return { lines, tooLong };
}

/* ───────────── ヘッダの書き換え ───────────── */

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

export type ReplaceResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-markers' | 'broken-markers'; message: string };

/** マーカーの間だけを置き換える。マーカーが無い / 壊れているときは何も返さない (勝手に挿入しない)。 */
export function replaceBlock(text: string, inner: string[]): ReplaceResult {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const begins = lines.flatMap((l, i) => (l.trim() === MARKER_BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === MARKER_END ? [i] : []));
  if (begins.length === 0 && ends.length === 0) {
    return { ok: false, reason: 'no-markers', message: 'ヘッダに auto prototypes のマーカーがありません' };
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) {
    return {
      ok: false,
      reason: 'broken-markers',
      message: `マーカーが不正です (begin ${begins.length} 個 / end ${ends.length} 個、または順序が逆)。1 組だけにしてください`,
    };
  }
  const next = [...lines.slice(0, begins[0] + 1), ...inner, ...lines.slice(ends[0])];
  return { ok: true, text: next.join(eol) };
}

export interface Insertion {
  text: string;
  /** 挿入した場所 (1 始まりの行番号) */
  line: number;
  where: string;
}

/**
 * マーカーが無いヘッダへの挿入案。インクルードガードの最後の `#endif` の直前、無ければファイル末尾。
 * これは提案を作るだけで、書き込みは承認の後に呼び出し側が行う。
 */
export function proposeInsertion(text: string, inner: string[]): Insertion {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 末尾の改行
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*#\s*endif\b/.test(lines[i])) {
      idx = i;
      break;
    }
  }
  const block = [MARKER_BEGIN, ...inner, MARKER_END];
  const insertAt = idx >= 0 ? idx : lines.length;
  const lead = insertAt > 0 && lines[insertAt - 1].trim() !== '' ? [''] : [];
  const trail = idx >= 0 ? [''] : [];
  lines.splice(insertAt, 0, ...lead, ...block, ...trail);
  return {
    text: lines.join(eol) + eol,
    line: insertAt + lead.length + 1,
    where: idx >= 0 ? '最後の #endif (インクルードガードの終わり) の直前' : 'ファイルの末尾',
  };
}

/* ───────────── 同期の計画 (ここでは書き込まない) ───────────── */

export type SyncPlan =
  | { kind: 'skip'; reason: string; hint?: string }
  | { kind: 'error'; reason: string; hint?: string; log?: string }
  | { kind: 'choose-header'; candidates: string[] }
  | {
      kind: 'ready';
      header: string;
      oldText: string;
      newText: string;
      count: number;
      excluded: number;
      tooLong: string[];
      changed: boolean;
      log: string;
    }
  | {
      kind: 'needs-markers';
      header: string;
      oldText: string;
      newText: string; // マーカーを挿入した提案
      insertion: Insertion;
      count: number;
      tooLong: string[];
      log: string;
    };

export interface PlanOptions {
  /** ヘッダを明示する (絶対パス)。設定より優先 */
  header?: string;
  /** テスト用: PATH の差し替え */
  envPath?: string;
}

export function protoSourceRoot(ctx: Context): string {
  return path.resolve(ctx.root, ctx.settings.protoSourceDir || ctx.settings.targetDir);
}

function resolveHeader(ctx: Context, sourceRoot: string, opts: PlanOptions): { header?: string; candidates?: string[]; error?: string } {
  if (opts.header) return { header: opts.header };
  if (ctx.settings.protoHeader) {
    const abs = path.resolve(ctx.root, ctx.settings.protoHeader);
    return fs.existsSync(abs) ? { header: abs } : { error: `設定 c42check.proto.header のヘッダが見つかりません: ${ctx.settings.protoHeader}` };
  }
  const all = [...new Set([...ctx.headers, ...scanSources(sourceRoot).headers])];
  if (all.length === 0) {
    return { error: '対象のヘッダ (.h) が見つかりません。設定 c42check.proto.header に指定してください' };
  }
  const marked = all.filter((h) => fs.readFileSync(h, 'utf8').includes(MARKER_BEGIN));
  if (marked.length === 1) return { header: marked[0] };
  if (marked.length > 1) return { candidates: marked };
  if (all.length === 1) return { header: all[0] };
  return { candidates: all };
}

/**
 * ctags で関数定義を抽出し、ヘッダにどう書くかの計画を作る。ファイルには一切書かない。
 * ctags が無い → skip / 結果が空・ctags の失敗・宣言に直せない関数・マーカー破損 → error (ヘッダは触らない)。
 */
export async function planSync(ctx: Context, opts: PlanOptions = {}): Promise<SyncPlan> {
  const ct = await resolveCtags(opts.envPath);
  if (!ct.bin) return { kind: 'skip', reason: ct.reason ?? 'ctags が使えません', hint: ct.hint };

  const sourceRoot = protoSourceRoot(ctx);
  if (!fs.existsSync(sourceRoot)) {
    return { kind: 'error', reason: `プロトタイプ抽出の対象ディレクトリがありません: ${sourceRoot}`, hint: '設定 `c42check.proto.sourceDir` を確認してください' };
  }
  const files = scanSources(sourceRoot).sources.filter((f) => f !== ctx.mainFile);
  if (files.length === 0) {
    return { kind: 'error', reason: `${sourceRoot} に .c ファイルがありません`, hint: '設定 `c42check.proto.sourceDir` を確認してください' };
  }

  const h = resolveHeader(ctx, sourceRoot, opts);
  if (h.error) return { kind: 'error', reason: h.error };
  if (h.candidates) return { kind: 'choose-header', candidates: h.candidates };
  const header = h.header!;

  const run = await runCtags(ct.bin, files, ctx.root, ctx.settings.staticTimeoutSec * 1000, ctx.signal);
  if (!run.ok) return { kind: 'error', reason: `ctags が失敗しました: ${run.error}`, log: run.log };

  const built = buildEntries(run.funcs);
  if (built.unsupported.length > 0) {
    const list = built.unsupported
      .map((u) => `  ${path.relative(ctx.root, u.file)}:${u.line} ${u.name}: ${u.reason}`)
      .join('\n');
    return {
      kind: 'error',
      reason: `宣言に直せない関数が ${built.unsupported.length} 件あります。ヘッダには触っていません`,
      hint: '関数ポインタを返す関数などは自動生成できません。マーカーの外に手書きで宣言し、その関数の定義を別の書き方にするか、static にしてください',
      log: `${run.log}\n${list}\n`,
    };
  }
  if (built.entries.length === 0) {
    return {
      kind: 'error',
      reason: `ctags の結果が空です (関数定義 ${run.funcs.length} 件、うち static / main で除外 ${built.excluded} 件)。ヘッダには触っていません`,
      hint: '対象ディレクトリ (`c42check.proto.sourceDir`) が正しいか、除外されない関数が 1 つ以上あるかを確認してください',
      log: run.log,
    };
  }

  const oldText = fs.readFileSync(header, 'utf8');
  const { lines, tooLong } = renderBlock(built.entries, sourceRoot);
  const rep = replaceBlock(oldText, lines);
  if (rep.ok) {
    return {
      kind: 'ready',
      header,
      oldText,
      newText: rep.text,
      count: built.entries.length,
      excluded: built.excluded,
      tooLong,
      changed: rep.text !== oldText,
      log: run.log,
    };
  }
  if (rep.reason === 'no-markers') {
    const insertion = proposeInsertion(oldText, lines);
    return { kind: 'needs-markers', header, oldText, newText: insertion.text, insertion, count: built.entries.length, tooLong, log: run.log };
  }
  return { kind: 'error', reason: rep.message, hint: `${MARKER_BEGIN} と ${MARKER_END} を 1 組だけ残してください` };
}

/* ───────────── 書き込みと、書き込み後の norminette ───────────── */

/** plan の newText をヘッダに書く。元の内容を返す (元に戻す用)。 */
export function applyPlan(plan: Extract<SyncPlan, { kind: 'ready' | 'needs-markers' }>): string {
  const previous = fs.readFileSync(plan.header, 'utf8');
  fs.writeFileSync(plan.header, plan.newText);
  return previous;
}

export interface NormCheck {
  status: 'pass' | 'fail' | 'skip';
  diags: Diag[];
  log: string;
  reason?: string;
}

/** 書き込み後のヘッダを norminette で検査する。 */
export async function checkHeaderNorm(ctx: Context, header: string): Promise<NormCheck> {
  const bin = ctx.tools.norminette;
  if (!bin) return { status: 'skip', diags: [], log: '', reason: 'norminette が見つからないため、ヘッダを検査できませんでした' };
  const rel = path.relative(ctx.root, header);
  const r = await exec(bin, [rel], { cwd: ctx.root, timeoutMs: ctx.settings.staticTimeoutSec * 1000, signal: ctx.signal });
  const log = `$ ${bin} ${rel}\n${stripAnsi(r.output)}`;
  const diags = parseNorminette(r.output, ctx.root);
  if (r.error) return { status: 'fail', diags, log, reason: r.error };
  return { status: r.code === 0 && diags.length === 0 ? 'pass' : 'fail', diags, log };
}

/* ───────────── 確認なしの同期 (実行時 / 保存時) ───────────── */

export interface AutoSyncResult {
  status: 'updated' | 'unchanged' | 'skip' | 'error' | 'needs-markers';
  message: string;
  hint?: string;
  header?: string;
  count?: number;
  norm?: NormCheck;
  log: string;
}

/**
 * 実行時 (段階 0) と保存時の同期。ここでは差分プレビューの承認を取れないので、
 * マーカーがあるときだけ書き換え、マーカーが無ければ何もしない (挿入は手動コマンドで承認を取って行う)。
 * 空の結果・ctags の失敗・宣言に直せない関数は、ヘッダに触らずエラーにする。
 */
export async function syncAuto(ctx: Context, opts: PlanOptions = {}): Promise<AutoSyncResult> {
  const plan = await planSync(ctx, opts);
  switch (plan.kind) {
    case 'skip':
      return { status: 'skip', message: plan.reason, hint: plan.hint, log: '' };
    case 'error':
      return { status: 'error', message: plan.reason, hint: plan.hint, log: plan.log ?? '' };
    case 'choose-header':
      return {
        status: 'skip',
        message: `対象のヘッダを特定できません (候補 ${plan.candidates.length} 件)`,
        hint: '設定 `c42check.proto.header` にヘッダを指定してください',
        log: '',
      };
    case 'needs-markers':
      return {
        status: 'needs-markers',
        message: `${path.relative(ctx.root, plan.header)} にマーカーが無いため同期していません`,
        hint: 'コマンド「ヘッダにプロトタイプを反映」で、挿入位置を確認して承認すると挿入できます',
        header: plan.header,
        log: plan.log,
      };
    case 'ready': {
      if (!plan.changed) {
        return { status: 'unchanged', message: `変更なし (${plan.count} 件)`, header: plan.header, count: plan.count, log: plan.log };
      }
      if (ctx.isFileDirty?.(plan.header)) {
        return {
          status: 'skip',
          message: `${path.relative(ctx.root, plan.header)} に未保存の変更があるため、同期しませんでした`,
          hint: 'ヘッダを保存してからもう一度実行してください',
          header: plan.header,
          log: plan.log,
        };
      }
      applyPlan(plan);
      const norm = await checkHeaderNorm(ctx, plan.header);
      return {
        status: 'updated',
        message: `${path.relative(ctx.root, plan.header)} に ${plan.count} 件を反映しました${norm.status === 'fail' ? ' (norminette が指摘しています)' : ''}`,
        header: plan.header,
        count: plan.count,
        norm,
        log: plan.log + norm.log,
      };
    }
  }
}
