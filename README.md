# 42 Check

42 Tokyo の課題 (C 言語、42 Norm 準拠) 向けに、検証ツール一式をチェックボックスで選び、ワンクリックで**段階的に (fail-fast で)** 実行する VS Code 拡張機能です。
F5 で CodeLLDB のデバッガを起動でき、**事前チェックに落ちたらデバッガも後続の手順も実行されません**。

この拡張は、既存の信頼できる拡張 (CodeLLDB、clangd) をつなぐ「司令塔」で、デバッガも言語サーバも自作していません。
方針と採用理由は [docs/existing-extensions.md](docs/existing-extensions.md)、動作確認の結果は [docs/verification.md](docs/verification.md)、容量の実測は [docs/size-report.md](docs/size-report.md) を参照してください。

> **状況**: コア (検証の実行、fail-fast、`compile_commands.json` 生成、launch / tasks の生成) は実際のツールでテスト済みです。
> VS Code 上での動作 (F5 でデバッガが止まること、依存拡張の自動導入) は開発環境に VS Code が無く**未確認**です。確認手順は [docs/verification.md](docs/verification.md) にあります。

## 実行の段階

前の段階が 1 つでも失敗したら、後続の段階は一切実行しません。skip (ツール未検出など) は失敗ではありませんが、結果一覧で明示されます。

| 段階 | 内容 |
|---|---|
| 0 準備 | 空き容量の確認 → `.42check/` の作り直し → ツール検出 → `compile_commands.json` / `.clangd` の生成 |
| 1 事前チェック (静的) | norminette / 警告強化ビルド (`-Wall -Wextra -Werror -Wshadow -Wconversion`) / clang-tidy (`clang-analyzer-*,bugprone-*`) / scan-build / `gcc -fanalyzer` |
| 2 動的チェック | ASan(AddressSanitizer) + UBSan(UndefinedBehaviorSanitizer) ビルドの実行 → valgrind 用の**別ビルド**の実行。任意で CBMC / Frama-C Eva (ネイティブにある場合のみ) |
| 3 デバッガ | F5 経由のときのみ。デバッグ用ビルド (`.42check/debug/prog`) の後、CodeLLDB が起動 |

- 同じ段階の中は全項目を実行して結果をまとめます (`c42check.failFast: "stage"`、既定)。`"step"` にすると最初の失敗で止まります。
- 止まった場所 (どの段階のどの項目か) は、通知と Output Channel (`42 Check`) に出ます。
- 校舎のツール名 (`clang-12`、`clang-tidy-12`、`scan-build-12`、`gcc-12`) を優先して検出し、無ければ素の名前、それも無ければ入っている最新版を使います (メイン機の Arch 向け)。

### 合否判定の補正 (ツールの既定の終了コードだけでは fail にならないもの)

| ツール | 補正 |
|---|---|
| clang-tidy | `--warnings-as-errors='*'` を付け、warning も fail |
| scan-build | `--status-bugs` を付け、バグ検出で非 0 |
| `gcc -fanalyzer` | `-Wanalyzer-*` の診断を error 扱い |
| UBSan | `-fno-sanitize-recover=undefined` で最初の違反で止める |
| valgrind | `--error-exitcode=99`、閉じていない (継承されていない) fd も fail |
| 動的チェックの実行 | stdin は `/dev/null`、制限時間 (`c42check.runTimeoutSec`) を超えると**検査が完了していないので skip** (失敗にはしません) |

プログラムが正常に `exit(1)` するだけでは、ASan / valgrind 側では失敗にしません (sanitizer / valgrind の報告があるかで判定)。

## インストール

校舎 (Ubuntu 22.04、sudo なし) とメイン機 (Arch + zsh) のどちらでも、sudo は不要です。

```sh
git clone https://github.com/keusidan/c42checker.git
cd c42checker
npm ci
npm run package                      # c42checker-0.1.0.vsix ができる (約 28KB)
code --install-extension c42checker-0.1.0.vsix
# 依存する 2 つの拡張を明示的に入れる (自動導入は未確認のため、確実な手順)
code --install-extension vadimcn.vscode-lldb
code --install-extension llvm-vs-code-extensions.vscode-clangd
```

- `node_modules` は約 144MB です。校舎の home (空き約 1.9GB) が心配なら、`.vsix` を作った後に `rm -rf node_modules` で消せます。
  メイン機でビルドした `.vsix` を Drive 経由で持っていくこともできます。
- **rclone でマウントした Drive 上に、ソース / `node_modules` / `.42check/` を置かないでください。**
  小さなファイルが大量にあると極端に遅くなり、VFS キャッシュは home 側に溜まり、ログアウトでマウントも消えます。
  ソースは Git で管理し、Drive は `.vsix` の受け渡しとバックアップに限ります。実行時に、ワークスペースが rclone のマウント上にあれば警告します。
- clangd のバイナリが PATH に無いと、clangd 拡張がダウンロードを提案します。承認すると home 配下に保存されて容量を使うので、**承認の前に `df -h ~` で空きを確認**してください (この拡張はダウンロードを代行しません)。

## 使い方

1. 課題のフォルダを VS Code で開く (信頼するかを聞かれたら、信頼する。Makefile の評価と対象プログラムの実行を行うため、信頼されていないワークスペースでは動きません)
2. アクティビティバーの **42 Check** を開く。段階ごとに項目が並び、チェックボックスで実行する項目を選ぶ (状態は `.vscode/settings.json` の `c42check.checks` に保存)
3. View タイトルの ▶、またはステータスバーの `42 Check` で実行。実行中は ■ で中止できる
4. 結果: 各項目に ✔ / ✘ / skip のアイコン。問題は Problems パネル (ファイル・行・列つき)、生ログはツールごとの Output Channel (`42 Check: <ツール名>`)
5. 未検出のツールは「未検出」と出て、実行すると **skip + 理由 + 対処案** になります (失敗ではありません)

### F5 でデバッグする

1. コマンドパレット → `42 Check: launch.json / tasks.json を生成・更新`
   - ファイルが無ければ作成。**既にあれば上書きせず**、差分 (マージ案) を見せて、承認後にだけ追記します (既存の項目は変更しません。JSON で書き出すため、既存のコメントは失われる点に注意)
   - 続けて、`debug.onTaskErrors` を `abort` にする提案が出ます。承認した場合だけ、このワークスペースの設定に書き込みます (勝手には書き換えません)
2. F5。既定の構成は **「Debug (42 Check: 事前チェック → LLDB)」**: 段階 0〜2 → デバッグ用ビルド → CodeLLDB の順。事前チェックに落ちると、デバッガは起動しません
3. 事前チェックを飛ばしたいときは、構成を **「Debug (skip checks) ※事前チェックを飛ばす」** に切り替える (デバッグ用ビルドだけ行う)
4. デバッグ用ビルドは `-g -O0 -fno-omit-frame-pointer` で `.42check/debug/prog` に出力します。ASan + UBSan 付きにするには `c42check.debug.sanitizer: true`
5. 引数は `c42check.runArgs` で変更できます。`cwd` と `terminal` は `c42check.debug.cwd` / `c42check.debug.terminal` (生成時に反映、既定は `${workspaceFolder}` と `integrated`)

### main を持たない課題 (libft など)

動的チェックとデバッグには `main` が要ります。`c42check.mainFile` にテスト用の main (`.c`) のパスを指定してください。

- 対象ソースに `main` が**無い**ときだけ、動的チェックとデバッグ用ビルドに追加されます (ソースに `main` があれば無視)
- `mainFile` は静的チェック (norminette など) の対象には**含まれません** (テスト用のコードなので)
- `c42check.compdb.includeMain` (既定 `true`) で、`compile_commands.json` に含めるかを切り替えられます (含めると clangd がテスト main も解析します)
- `main` が無く `mainFile` も無いときは、動的チェックは skip になり、理由と設定の案内が出ます
- テスト main を課題のフォルダ内 (`tests/` など) に置いたとき、`mainFile` を指定しないと、それは通常のソースとして扱われます (norminette の対象になります)

## clangd との関係 (重要)

- 言語サーバは既存の clangd 拡張を使います。この拡張は、段階 0 でワークスペースのルートに `compile_commands.json` と `.clangd` を生成するだけです。
  `bear` / `compiledb` は不要です。ソースの増減や設定変更のあとは、コマンド `42 Check: compile_commands.json / .clangd を再生成` で更新できます。
- 生成方式 (`c42check.compdb.source`): `auto` (既定: Makefile があれば `make -n -B` を解析、取れなければ `files`) / `files` (ソース一覧から直接) / `make-n` / `clang-MJ` (`clang -MJ` の断片を結合)。
  `make -n` は Makefile を評価します (`$(shell ...)` は実行されます)。
- `.clangd` は、`# generated by c42check` で始まるものだけを更新し、**既存の自作の `.clangd` は上書きしません**。
- **clangd 内蔵の clang-tidy は、編集中の参考表示です。段階 1 の合否判定は、42 Check が直接実行する clang-tidy (校舎では `clang-tidy-12`) の結果を正とします。**
  両者は版も設定も違うため、編集中に出た警告とここでの結果が一致しないことがあります。
- Microsoft C/C++ (`ms-vscode.cpptools`) は clangd と競合します。入っていれば通知しますが、設定は書き換えません。

## 設定

| 設定 | 既定値 | 内容 |
|---|---|---|
| `c42check.targetDir` | `.` | 検証対象のディレクトリ |
| `c42check.includePaths` | `[]` | 追加の include path (`.h` を含むディレクトリは自動で追加) |
| `c42check.runArgs` | `[]` | 動的チェックとデバッグの実行引数 |
| `c42check.useMakeCheckTarget` | `false` | Makefile に `check` ターゲットがあれば、scan-build は `make` の代わりに `make check` を包んで実行 |
| `c42check.failFast` | `"stage"` | `"stage"`: 段階内は全項目を実行 / `"step"`: 最初の失敗で止める |
| `c42check.minFreeSpaceMB` | `200` | 空き容量の下限 (MB)。下回ると警告して中断 |
| `c42check.workDirMaxMB` | `100` | `.42check/` の上限 (MB)。超えると警告して中断 |
| `c42check.runTimeoutSec` | `10` | 動的チェックの実行の制限時間 (秒。valgrind は 5 倍)。超過は skip |
| `c42check.staticTimeoutSec` | `120` | 静的チェック各ツールの制限時間 (秒) |
| `c42check.mainFile` | `""` | main を持たない課題用のテスト main |
| `c42check.compdb.includeMain` | `true` | `mainFile` を `compile_commands.json` に含めるか |
| `c42check.compdb.source` | `"auto"` | `compile_commands.json` の生成方式 |
| `c42check.debug.sanitizer` | `false` | デバッグ用ビルドに ASan + UBSan を付ける |
| `c42check.debug.cwd` / `.terminal` | `${workspaceFolder}` / `integrated` | launch 構成に反映 |
| `c42check.checks` | (全項目。CBMC / Frama-C のみ `false`) | チェックボックスの状態 (View から変更すると保存される) |

`.42check/` は実行のたびに削除して作り直し、`.gitignore` に自動で追記します。

## 動作確認用のサンプル

`samples/` の各フォルダを VS Code でフォルダとして開いて試せます (そのフォルダが課題のルートの想定)。

| サンプル | 内容 | 期待される結果 |
|---|---|---|
| `samples/ok` | norm 準拠で、バグ無し | 段階 0〜2 とデバッグ用ビルドがすべて pass |
| `samples/norm-ng` | 動作は正常だが norm 違反 | 段階 1 の norminette で fail、段階 2 は実行されない |
| `samples/bug-asan` | 実行時の heap-buffer-overflow (静的解析では見えにくい) | 段階 1 は pass、段階 2 で ASan と valgrind が fail |
| `samples/bug-leak` | メモリリーク + 閉じていない fd | 段階 1 の clang-tidy と scan-build が fail (段階 2 は実行されない) |
| `samples/lib-ok` | main の無いライブラリ課題。`tests/test_main.c` を `c42check.mainFile` で指定 | 動的チェックとデバッグ用ビルドまで pass |

実機での確認手順 (F5、依存拡張の導入) は [docs/verification.md](docs/verification.md) を参照してください。

## 開発

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # esbuild で dist/extension.js に bundle
npm test            # 46 件。実際のツール (norminette / clang / valgrind など) があれば使い、無ければ該当項目は skip
npm run package     # .vsix を作る
```

構成: `src/core/` は VS Code に依存しない純 TypeScript (検証の実行、parser、`compile_commands.json` 生成、launch 構成の生成) で、
`src/ui/` が VS Code との接続 (TreeView、Task、Diagnostics、Output Channel) です。実行時の依存パッケージはありません。

## 既知の制限

- scan-build は、Makefile が `CC` を固定していても `make CC="$CC"` で上書きして ccc-analyzer を通しますが、レシピがコンパイラを直接 (`gcc` と) 書いている場合は解析されません。
  元のツリーを汚さないよう、`.42check/scan-build/src` にコピーして `make -B` で全ビルドします。
- GUI や無限ループの課題 (so_long、cub3d など) は、制限時間を超えるため動的チェックが skip になります。その項目のチェックを外してください。
- ツールの版が違うと検出結果が変わりえます。開発時の確認は clang 18 / gcc 13 / valgrind 3.22 で行っており、校舎の `-12` 系での確認は未実施です。
