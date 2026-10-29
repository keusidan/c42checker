// Norm v4.1 III.11: Makefile の規則 (norminette は Makefile を検査しない)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkMakefileText, logicalLines, ruleTargets } from '../src/core/makefile';
import { runPipeline } from '../src/core/pipeline';
import type { Context } from '../src/core/types';
import { sampleContext } from './helpers';

const stepOf = (r: Awaited<ReturnType<typeof runPipeline>>) => r.results.find((x) => x.id === 'makefile')!;
const needMake = (ctx: Context) => ctx.tools.make !== undefined && ctx.tools.cc !== undefined;
const readMk = (dir: string) => fs.readFileSync(path.join(dir, 'Makefile'), 'utf8');
const writeMk = (dir: string, s: string) => fs.writeFileSync(path.join(dir, 'Makefile'), s);
const GENERATED = new Set(['.42check', '.clangd', 'compile_commands.json']); // 段階 0 が作るもの
const tree = (dir: string) => fs.readdirSync(dir).filter((n) => !GENERATED.has(n)).sort();

/* ───────────── 静的な検査 ───────────── */

test('規則の目標名の読み取り: 複数の目標・$(NAME)・代入 (:=) と recipe を区別し、コメントと行継続を扱う', () => {
  const text = [
    'NAME := prog # comment',
    'SRCS = a.c \\',
    '       b.c',
    '',
    'all: $(NAME)',
    '$(NAME): $(OBJS)',
    '\t$(CC) -o $@ $^   # not: a target',
    'clean fclean:',
    '\trm -f x',
    '${NAME}-dev: all',
    '.PHONY: all',
  ].join('\n');
  const lines = logicalLines(text);
  assert.equal(lines.find((l) => l.text.startsWith('SRCS'))?.text.replace(/\s+/g, ' '), 'SRCS = a.c b.c');
  assert.deepEqual(ruleTargets(lines), ['all', '$(NAME)', 'clean', 'fclean', '${NAME}-dev', '.PHONY']);
});

const GOOD = 'NAME = prog\nSRCS = a.c b.c\nOBJS = $(SRCS:.c=.o)\n\nall: $(NAME)\n\n$(NAME): $(OBJS)\n\t$(CC) -o $(NAME) $(OBJS)\n\nclean:\n\trm -f $(OBJS)\n\nfclean: clean\n\trm -f $(NAME)\n\nre: fclean all\n\n.PHONY: all clean fclean re\n';

test('Makefile (静的): 必須の規則が揃っていれば問題なし。足りない規則と NAME は error', () => {
  assert.deepEqual(checkMakefileText(GOOD, '/w'), []);
  const noRe = checkMakefileText(GOOD.replace('re: fclean all\n', ''), '/w');
  assert.equal(noRe.length, 1);
  assert.match(noRe[0].message, /規則 re がありません/);
  assert.equal(noRe[0].strength, 'error');
  const noName = checkMakefileText(GOOD.replace('NAME = prog', 'BIN = prog').replace(/\$\(NAME\)/g, '$(BIN)'), '/w');
  assert.ok(noName.some((f) => /変数 NAME/.test(f.message)));
  assert.ok(noName.some((f) => /規則 \$\(NAME\) がありません/.test(f.message)));
  // ${NAME} の書き方も同じ扱い
  assert.deepEqual(checkMakefileText(GOOD.replace(/\$\(NAME\)/g, '${NAME}'), '/w'), []);
});

test('Makefile (静的): wildcard / find / *.c でソースを列挙するのは error。clean の rm *.o は問題なし', () => {
  const wc = checkMakefileText(GOOD.replace('SRCS = a.c b.c', 'SRCS = $(wildcard *.c)'), '/w');
  assert.equal(wc.length, 1);
  assert.match(wc[0].message, /wildcard/);
  assert.equal(checkMakefileText(GOOD.replace('SRCS = a.c b.c', 'SRCS = $(shell find . -name "*.c")'), '/w').length, 1);
  assert.equal(checkMakefileText(GOOD.replace('\t$(CC) -o $(NAME) $(OBJS)', '\t$(CC) -o $(NAME) *.c'), '/w').length, 1);
  assert.deepEqual(checkMakefileText(GOOD.replace('\trm -f $(OBJS)', '\trm -f *.o'), '/w'), [], 'clean の rm は除く');
  assert.deepEqual(checkMakefileText(GOOD.replace('SRCS = a.c b.c', '# SRCS = $(wildcard *.c)\nSRCS = a.c b.c'), '/w'), [], 'コメントの中は見ない');
});

test('Makefile (静的): 同梱のライブラリ (Makefile のあるディレクトリ) を -C などでビルドしていなければ error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-mkl-'));
  fs.mkdirSync(path.join(dir, 'libft'));
  fs.writeFileSync(path.join(dir, 'libft', 'Makefile'), 'all:\n');
  const withLib = GOOD.replace('\t$(CC) -o $(NAME) $(OBJS)', '\t$(CC) -o $(NAME) $(OBJS) -Llibft -lft');
  const f = checkMakefileText(withLib, dir);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /libft/);
  assert.equal(f[0].strength, 'error');
  assert.deepEqual(checkMakefileText(withLib.replace('all: $(NAME)', 'all: $(NAME)\n\n$(NAME): libft_build\nlibft_build:\n\t$(MAKE) -C libft'), dir), [], '$(MAKE) -C libft があれば問題なし');
  assert.deepEqual(checkMakefileText(withLib.replace('-Llibft', '-L./libft').replace('all: $(NAME)', 'lib:\n\tmake -C ./libft\n\nall: $(NAME)'), dir), []);
  assert.deepEqual(checkMakefileText(withLib.replace('-Llibft', '-L/usr/lib'), dir), [], 'Makefile のない (システムの) ディレクトリは対象外');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ───────────── make を動かす検査 ───────────── */

test('step: 正しい Makefile (samples/ok) は pass。元のファイルは変えない (成果物を作らない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  const before = tree(dir);
  const r = await runPipeline(ctx, { selected: ['makefile'] });
  const s = stepOf(r);
  assert.equal(s.status, 'pass', s.log);
  assert.deepEqual(tree(dir), before, 'プロジェクト直下にビルド成果物が増えていない');
  assert.ok(!fs.existsSync(path.join(dir, '.42check', 'makefile-check')), '作業用のコピーは消す');
  assert.match(s.log, /\$ make {2}\(終了コード 0\)/);
  assert.match(s.log, /Nothing to be done/);
  assert.match(s.log, /機械では判定できない項目/);
  cleanup();
});

test('step: Makefile が無ければ skip (失敗ではない)', async () => {
  const { ctx, cleanup } = sampleContext('ok', {}, ['Makefile']);
  const r = await runPipeline(ctx, { selected: ['makefile'] });
  const s = stepOf(r);
  assert.equal(s.status, 'skip');
  assert.match(s.reason ?? '', /Makefile がありません/);
  assert.equal(r.ok, true);
  cleanup();
});

test('step: 毎回リビルドする (relink) Makefile は fail', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  writeMk(dir, readMk(dir).replace('.PHONY: all clean fclean re', '.PHONY: all clean fclean re $(NAME)'));
  const s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail', s.log);
  assert.ok(s.diags.some((d) => /relink/.test(d.message) && d.severity === 'error'), JSON.stringify(s.diags));
  assert.equal(s.diags[0].source, 'makefile');
  assert.ok(s.diags[0].file.endsWith('Makefile'));
  cleanup();
});

test('step: 毎回 .o を作り直す (オブジェクトを依存に書かない) Makefile も relink として fail', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  writeMk(dir, 'NAME = ok\nCC = cc\n\nall: $(NAME)\n\n$(NAME): main.c str_utils.c\n\t$(CC) main.c str_utils.c -o $(NAME)\n\nclean:\n\trm -f *.o\n\nfclean: clean\n\trm -f $(NAME)\n\nre: fclean all\n\n.PHONY: all clean fclean re\n');
  const s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'pass', '依存にソースを書いていれば、2 回目は何も起きない (wildcard も使っていない)\n' + s.log);
  writeMk(dir, readMk(dir).replace('$(NAME): main.c str_utils.c', '$(NAME): FORCE').replace('.PHONY:', 'FORCE:\n\n.PHONY:'));
  const s2 = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s2.status, 'fail');
  assert.ok(s2.diags.some((d) => /relink/.test(d.message)));
  cleanup();
});

test('step: all が最初の規則でない (make だけでは all が動かない) と fail', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  const mk = readMk(dir);
  // $(NAME) の規則を all より前に置く
  writeMk(dir, mk.replace('all: $(NAME)\n\n', '').replace('$(NAME): $(OBJS)', '$(NAME): $(OBJS)').replace('%.o: %.c', 'all: $(NAME)\n\n%.o: %.c'));
  const s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail', s.log);
  assert.ok(s.diags.some((d) => /all ではなく/.test(d.message)), JSON.stringify(s.diags));
  cleanup();
});

test('step: clean で .o が消えない / fclean で成果物が消えない / 規則が無い → fail', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  const mk = readMk(dir);

  writeMk(dir, mk.replace('clean:\n\trm -f $(OBJS)', 'clean:\n\t@echo nothing'));
  let s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  assert.ok(s.diags.some((d) => /make clean の後にオブジェクトファイルが残っています/.test(d.message)), JSON.stringify(s.diags));

  writeMk(dir, mk.replace('fclean: clean\n\trm -f $(NAME)', 'fclean: clean\n\t@echo nothing'));
  s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  assert.ok(s.diags.some((d) => /make fclean の後にビルドの成果物が残っています/.test(d.message)), JSON.stringify(s.diags));

  writeMk(dir, mk.replace('re: fclean all\n\n', ''));
  s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  assert.ok(s.diags.some((d) => /規則 re がありません/.test(d.message)));
  cleanup();
});

test('step: make 自体が失敗する Makefile は fail (理由つき)。ソースを wildcard で列挙するものも fail', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!needMake(ctx)) return t.skip('make / cc が無い');
  const mk = readMk(dir);
  fs.writeFileSync(path.join(dir, 'str_utils.c'), 'this is not C');
  let s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  assert.ok(s.diags.some((d) => /make が失敗しました/.test(d.message)), JSON.stringify(s.diags));
  cleanup();

  const w = sampleContext('ok');
  writeMk(w.dir, mk.replace('SRCS = main.c str_utils.c', 'SRCS = $(wildcard *.c)'));
  s = stepOf(await runPipeline(w.ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  assert.ok(s.diags.some((d) => /wildcard/.test(d.message)));
  void dir;
  w.cleanup();
});

test('step: make が無ければ、静的な検査だけを行い、理由をログに残す。静的な検査で error があれば fail', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  ctx.tools = { ...ctx.tools, make: undefined };
  let s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'pass', s.log);
  assert.match(s.log, /make が無いため、動かす検査/);
  writeMk(dir, readMk(dir).replace('re: fclean all\n\n', ''));
  s = stepOf(await runPipeline(ctx, { selected: ['makefile'] }));
  assert.equal(s.status, 'fail');
  cleanup();
});

test('既定: normExtra と makefile は ON。Makefile の無いプロジェクトでは skip になるので、既存の実行を妨げない', async () => {
  const { ctx, cleanup } = sampleContext('ok', {}, ['Makefile']);
  assert.equal(ctx.settings.checks.normExtra, true);
  assert.equal(ctx.settings.checks.makefile, true);
  const r = await runPipeline(ctx, { selected: ['makefile', 'normExtra'] });
  assert.equal(r.ok, true);
  cleanup();
});
