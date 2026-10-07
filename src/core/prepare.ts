import * as fs from 'node:fs';
import { generateClangd, generateCompdb } from './compdb';
import { buildInputs } from './build';
import { ensureGitignore, freeSpaceMB, isOnRcloneMount, resetWorkDir } from './workdir';
import type { Context, StepOutcome } from './types';

/**
 * 段階 0: 準備。
 *  1. rclone マウント上のワークスペースを警告 / 2. 空き容量の確認 (不足なら中断)
 *  3. .42check/ の作り直し / 4. ツールと対象の確認 / 5. compile_commands.json と .clangd の生成
 * compile_commands.json の生成失敗は clangd 用の補助なので警告に留め、検査自体は止めない。
 */
export async function prepare(ctx: Context): Promise<StepOutcome> {
  let log = '';
  const say = (s: string) => {
    log += s + '\n';
  };

  if (isOnRcloneMount(ctx.root)) {
    say('警告: ワークスペースが rclone のマウント上にあります。小さなファイルが大量にあると極端に遅くなり、ログアウトでマウントも消えます。home 配下 (非マウント) に置いてください。');
  }

  let free: number;
  try {
    free = freeSpaceMB(ctx.root);
  } catch (e) {
    return { status: 'fail', diags: [], log: log + `空き容量を取得できませんでした: ${String(e)}\n`, reason: '空き容量を確認できません' };
  }
  say(`空き容量: ${free}MB (閾値 ${ctx.settings.minFreeSpaceMB}MB)`);
  if (free < ctx.settings.minFreeSpaceMB) {
    return {
      status: 'fail',
      diags: [],
      log,
      reason: `空き容量が ${free}MB で、閾値 ${ctx.settings.minFreeSpaceMB}MB を下回っています`,
      hint: '`df -h ~` で確認し、不要なファイルを消すか、設定 `c42check.minFreeSpaceMB` を見直してください',
    };
  }

  try {
    resetWorkDir(ctx.workDir);
    if (ensureGitignore(ctx.root)) say('.gitignore に .42check/ を追記しました');
  } catch (e) {
    return { status: 'fail', diags: [], log: log + `.42check/ を準備できませんでした: ${String(e)}\n`, reason: '.42check/ を準備できません' };
  }

  if (ctx.sources.length === 0) {
    return {
      status: 'fail',
      diags: [],
      log: log + `${ctx.targetRoot} に .c ファイルがありません\n`,
      reason: '対象の .c ファイルがありません',
      hint: '設定 `c42check.targetDir` を確認してください',
    };
  }
  say(`対象: .c ${ctx.sources.length} 件 / .h ${ctx.headers.length} 件 / include ${ctx.includeDirs.length} 件`);
  const inputs = buildInputs(ctx);
  say(
    ctx.hasMain
      ? 'main: 対象ソース内にあり'
      : ctx.mainFile
        ? `main: なし → mainFile (${ctx.mainFile}) を動的チェックに追加します`
        : 'main: なし (動的チェックは skip されます。mainFile を設定してください)',
  );
  if (inputs.note) say(`注意: ${inputs.note}`);
  if (ctx.settings.mainFile && !ctx.mainFile) {
    say(`警告: c42check.mainFile (${ctx.settings.mainFile}) が見つかりません`);
  }
  say(
    'ツール: ' +
      Object.entries(ctx.tools)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );

  try {
    const r = await generateCompdb(ctx);
    say(`compile_commands.json を生成しました (${r.method}, ${r.entries} 件)${r.note ? ` — ${r.note}` : ''}`);
    const c = generateClangd(ctx.root);
    say(c.written ? '.clangd を生成しました' : `.clangd: ${c.reason}`);
  } catch (e) {
    say(`警告: compile_commands.json を生成できませんでした: ${String(e)}`);
  }
  if (ctx.signal?.aborted) return { status: 'fail', diags: [], log, reason: '中止されました' };
  fs.mkdirSync(ctx.workDir, { recursive: true });
  return { status: 'pass', diags: [], log };
}
