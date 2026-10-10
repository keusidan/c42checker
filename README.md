# 42 Check

42 Tokyo の課題 (C 言語、42 Norm 準拠) 向けに、検証ツール一式をチェックボックスで選び、ワンクリックで**段階的に (fail-fast で)** 実行する VS Code 拡張機能です。
F5 で CodeLLDB のデバッガを起動でき、**事前チェックに落ちたらデバッガも後続の手順も実行されません**。

この拡張は、既存の信頼できる拡張 (CodeLLDB、clangd) をつなぐ「司令塔」で、デバッガも言語サーバも自作していません。
方針と採用理由は [docs/existing-extensions.md](docs/existing-extensions.md)、動作確認の結果は [docs/verification.md](docs/verification.md)、容量の実測は [docs/size-report.md](docs/size-report.md) を参照してください。

> **状況**: コア (検証の実行、fail-fast、`compile_commands.json` 生成、launch / tasks の生成) は実際のツールでテスト済みです。
> 校舎マシン (Ubuntu 22.04、`-12` 系のツール) の実機で、サンプル 5 つに対して全チェック項目を 1 つずつ実行し、期待どおりの結果になることが報告されています
> (詳細は [docs/verification.md](docs/verification.md))。
> **VS Code の画面上の動作** (F5 でデバッガが止まること、Problems への表示、clangd の補完) は、まだ確認できていません。

## 実行の段階

前の段階が 1 つでも失敗したら、後続の段階は一切実行しません。skip (ツール未検出など) は失敗ではありませんが、結果一覧で明示されます。

| 段階 | 内容 |
|---|---|
| 0 準備 | 空き容量の確認 → `.42check/` の作り直し → ツール検出 → `compile_commands.json` / `.clangd` の生成 |
| 1 事前チェック (静的) | (任意) c_formatter_42 による整形 → norminette / 警告強化ビルド (`-Wall -Wextra -Werror -Wshadow -Wconversion`) / clang-tidy (`clang-analyzer-*,bugprone-*`) / scan-build / `gcc -fanalyzer` |
| 2 動的チェック | ASan(AddressSanitizer) + UBSan(UndefinedBehaviorSanitizer) / TSan(ThreadSanitizer) / MSan(MemorySanitizer) / valgrind を、**項目ごとに別ビルド**で実行。任意で CBMC / Frama-C Eva (ネイティブにある場合のみ) |
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
| TSan | `WARNING: ThreadSanitizer` の報告で fail (データ競合の位置に診断)。制限時間は他の 3 倍 |
| MSan | `WARNING: MemorySanitizer` の報告で fail (未初期化値の使用位置に診断、origins を追跡)。制限時間は他の 3 倍 |
| 動的チェックの実行 | stdin は `/dev/null`、制限時間 (`c42check.runTimeoutSec`) を超えると**検査が完了していないので skip** (失敗にはしません) |

プログラムが正常に `exit(1)` するだけでは、ASan / valgrind 側では失敗にしません (sanitizer / valgrind の報告があるかで判定)。

### c_formatter_42 による整形 (norminette の前)

段階 1 の**先頭** (norminette の前) に、`c_formatter_42` でソースを整形する項目があります。View の段階 1 の「c_formatter_42 (整形)」にチェックを入れると、
norminette の前に `.c` / `.h` を整形します (整形後のファイルを norminette が検査します)。

- **ソースをその場で書き換えます。そのため既定は OFF です。** `mainFile` (テスト用の main) は対象外です。
- 入れ方: `pipx install c-formatter-42` (または `pip install --user c-formatter-42`)。clang-format は c_formatter_42 に同梱なので、別に要りません。
  未導入なら、失敗ではなく skip + 対処案になります。動作確認は c_formatter_42 0.2.8 で行いました。
- 変更前の内容は `.42check/format-backup/` に退避します (次の実行で消えます。git で管理していれば `git diff` / `git checkout` でも戻せます)。
- エディタに**未保存の変更があるファイル**があれば、何も書き換えずに skip します。
- **整形でコードが壊れたら、変更したファイルをすべて元に戻して fail にします。** 整形の前にコンパイル (構文チェック) が通っていたのに、整形の後に通らなくなったときが対象です。
  実際に、次の 2 つで壊れることを確認しています。
  - **80 桁を超える文字列リテラル**: 1 回目の整形がリテラルの途中で改行してしまい、2 回目でさらに崩れます (`%zu` が `% zu` になる)。リテラルを `"..." "..."` のように手で分割してから使ってください。
  - **`#include` の順序に依存したコード**: c_formatter_42 は `#include` を並び替えます (`"..."` を `<...>` より前に)。ヘッダが自分で必要な `#include` を持たない場合、並び替えでコンパイルできなくなります。
- ワークスペース直下の `.clang-format` には触れません (c_formatter_42 は cwd の `.clang-format` を一時的に差し替えるため、`.42check/` 内の空のディレクトリで実行します)。
- 「ヘッダにプロトタイプを反映」が書いたブロックとは干渉しません (同期 → 整形 → 同期で、ブロックは変わらないことを確認済み)。

### sanitizer の選択 (ASan+UBSan / TSan / MSan)

sanitizer は互いに併用できないため、View の段階 2 に**別々のチェックボックス**として並んでいます (既定は ASan+UBSan が ON、TSan と MSan は OFF)。
複数にチェックすると、**複数回に分けて**、項目ごとに別ビルド (`.42check/asan/`、`tsan/`、`msan/`) で順番に実行され、結果も項目ごとに出ます。

- TSan はスレッドを使う課題 (philosophers など) で意味があります。MSan は clang 専用です。
- MSan は、プログラムが使うコードのすべてが instrument されている必要があり、そうでないと誤検出することがあります (libc は主な関数を interceptor が補います)。
  MSan の誤検出が疑わしいときは、valgrind の結果と照らして判断してください。出典: [MemorySanitizer — Clang docs (版つきの複製)](https://releases.llvm.org/3.6.2/tools/docs/MemorySanitizer.html)
- sanitizer のランタイム (Ubuntu: `libclang-rt-<版>-dev`) が無い、または TSan / MSan がカーネルの ASLR 設定で起動できない環境では、**失敗ではなく skip + 理由 + 対処案**になります。
  TSan / MSan 付きのプログラムが、**プロジェクトのコードとは無関係に起動時に SEGV で落ちた**場合 (報告が無い、またはスタックが sanitizer のランタイム内だけ) も、環境の問題として skip にします。ユーザーのコードが落ちた場合はスタックにそのフレームが出るので、fail のままです。
  後者は `sudo sysctl vm.mmap_rnd_bits=28` で回避できることがありますが、sudo の無い校舎では使えません。出典: [PX4 docs: Sanitizers](https://docs.px4.io/main/en/test_and_ci/sanitizers)、[ziggit: ThreadSanitizer: unexpected memory mapping error](https://ziggit.dev/t/threadsanitizer-unexpected-memory-mapping-error/4930)

## インストール

**推奨: メイン機 (Arch) で `.vsix` をビルドし、校舎には `.vsix` だけを持っていく。**
ビルドには **Node.js 22 以上**が要ります (`@vscode/vsce` は Node 22 以上、esbuild は Node 18 以上、テストの `node --test` も新しい Node が必要)。
校舎の Node は **v12.22.9** なので、校舎ではビルドもテストもできません (`node esbuild.mjs` は構文エラーで止まります)。
拡張そのものは VS Code 同梱の Node で動くため、校舎の Node の版は関係ありません。

```sh
# メイン機 (Node 22 以上):
git clone https://github.com/keusidan/c42checker.git
cd c42checker
npm ci
npm run package                      # c42checker-0.1.0.vsix ができる (約 41KB)

# 校舎 (sudo 不要。.vsix を Drive などで持ってくる):
code --install-extension c42checker-0.1.0.vsix
```

依存する 2 つの拡張のうち、clangd 拡張は `.vsix` のインストールで自動的に入ることが確認できています (`extensionPack`)。
CodeLLDB (`extensionDependencies`) は、確認した環境にすでに入っていたため、自動導入は未確認です。入っていなければ、次を実行してください。

```sh
code --install-extension vadimcn.vscode-lldb
code --install-extension llvm-vs-code-extensions.vscode-clangd
```

- 校舎でどうしてもビルドする場合は、sudo なしで Node 22 を入れる方法として、公式の `tar.xz` を home に展開できます
  (例: `https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz`)。ただし展開後は約 205MB あり、`node_modules` (約 144MB) も加わります。
  **校舎の home の空きは実測で約 1.1GB** (4.7GB 中 3.6GB 使用) でした。CodeLLDB (165MB) と clangd (拡張 1.5MB + バイナリ 225MB) を入れた状態で、さらに Node + `node_modules` で約 350MB 増えるため、余裕は小さくなります。
  内訳と合計は [docs/size-report.md](docs/size-report.md) を参照してください。
- ビルドした後は `rm -rf node_modules` で 144MB を解放できます。
- **rclone でマウントした Drive 上に、ソース / `node_modules` / `.42check/` を置かないでください。**
  小さなファイルが大量にあると極端に遅くなり、VFS キャッシュは home 側に溜まり、ログアウトでマウントも消えます。
  ソースは Git で管理し、Drive は `.vsix` の受け渡しとバックアップに限ります。実行時に、ワークスペースが rclone のマウント上にあれば警告します。
- clangd のバイナリが PATH に無いと、clangd 拡張がダウンロードします。実機では `.vsix` のインストールの約 1 分後にダウンロードされ、
  `~/.config/Code/User/globalStorage/llvm-vs-code-extensions.vscode-clangd/install/` に約 225MB が保存され、`clangd.path` がユーザー設定に自動で書き込まれました。
  容量を使うので、**`.vsix` を入れる前に `df -h ~` で空きを確認**してください (この拡張はダウンロードを代行しません)。
  容量が足りない場合は、clangd 拡張を入れなくても検証 (段階 0〜2) と F5 は使えます。

## 使い方

1. 課題のフォルダを VS Code で開く (信頼するかを聞かれたら、信頼する。Makefile の評価と対象プログラムの実行を行うため、信頼されていないワークスペースでは動きません)
2. アクティビティバーの **42 Check** を開く。段階ごとに項目が並び、チェックボックスで実行する項目を選ぶ (状態は `.vscode/settings.json` の `c42check.checks` に保存)
3. View タイトルの ▶、またはステータスバーの `42 Check` で実行。実行中は ■ で中止できる
4. 結果: 各項目に ✔ / ✘ / skip のアイコン。問題は Problems パネル (ファイル・行・列つき)、生ログはツールごとの Output Channel (`42 Check: <ツール名>`)
5. 未検出のツールは「未検出」と出て、実行すると **skip + 理由 + 対処案** になります (失敗ではありません)
6. View の下の方に、**「ヘッダ」**(プロトタイプの反映) と **「設定」**(真偽値の設定のチェックボックス) のグループがあります (次の 2 節)

### 設定のチェックボックス (View の「設定」グループ)

次の 5 つを、settings.json を開かずに ON / OFF できます。状態は**ワークスペースの settings.json の対応キーと双方向に同期**します
(View で変えると settings.json が書き換わり、settings.json を直接編集すると View のチェックが追従します)。**5 つとも既定は OFF** です。

| チェックボックス | 対応する設定キー |
|---|---|
| failFast を step にする | `c42check.failFast` (ON = `"step"` / OFF = `"stage"`) |
| ASan 付きデバッグ | `c42check.debug.sanitizer` |
| Makefile の check ターゲットを使う | `c42check.useMakeCheckTarget` |
| 実行時 (段階 0) にプロトタイプを同期 | `c42check.proto.syncOnRun` |
| 保存時にプロトタイプを同期 | `c42check.proto.syncOnSave` |

### ヘッダにプロトタイプを反映

`.c` の関数定義からプロトタイプを作り、ヘッダの**マーカーの間だけ**を書き換えます。抽出には **universal-ctags** (`ctags-universal`) を使い、C のパーサは自作していません。

```c
/* ---- auto prototypes begin ---- */
/* ---- auto prototypes end ---- */
```

- コマンドパレットの「42 Check: ヘッダにプロトタイプを反映」、または View の「ヘッダ」グループの項目から実行します。
- 対象は `c42check.proto.sourceDir` 以下の `.c` (再帰。空なら `c42check.targetDir`)。**static 関数と `main` は除外**します。同名の定義が複数あれば (`#ifdef`) 最初の 1 つだけです。
- 書き込み先は `c42check.proto.header` (空ならマーカーのあるヘッダを自動選択。複数あれば選択を求めます)。
- **書き換える前に、差分をプレビューで表示**し、承認してから書き込みます。
- **マーカーが無いヘッダには、勝手に挿入しません。** 挿入位置 (最後の `#endif` の直前、ガードが無ければ末尾) と差分を見せて、承認を取ります。マーカーが壊れている (片方だけ、重複、順序が逆) 場合はエラーです。
- 42 Norm の形式で出力します: 戻り値の型の後ろはタブ、ポインタは関数名側に寄せ (`char\t*ft_strdup(const char *s);`)、関数名の桁を揃え、**ファイル名のコメントや空行は入れず、関数名の順 (文字コード順) に詰めて並べます**。引数なしは `(void)` にします。マーカーの 2 行はそのまま残ります。
- **書き込み後に `norminette` でヘッダを検査**します。指摘があれば Problems に出し、「元に戻す」を選べます。
- **ctags の結果が空** (対象に static / main しか無い、`.c` が無いなど)、ctags が失敗した、関数ポインタを返す関数など宣言に直せないものがある、ヘッダに未保存の変更がある、のいずれかなら、**ヘッダに触らずエラー**にします。
- ctags が無い、または Universal Ctags ではない (Exuberant / GNU 版) 環境では、**skip + 理由 + 対処案**を表示します。
- 「実行時 (段階 0)」と「保存時」の自動同期 (既定 OFF) は、承認を取れないため**差分プレビューを出さず**、マーカーがあるヘッダだけを書き換えます (マーカーが無ければ何もしません)。
  実行時の同期で、結果が空・ctags の失敗が起きたときは、段階 0 で失敗として止まります。ctags が無いときは skip で、実行は続きます。

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
| `c42check.proto.header` | `""` | プロトタイプを反映するヘッダ (空ならマーカーのあるヘッダを自動選択) |
| `c42check.proto.sourceDir` | `""` | 関数定義を抽出する `.c` のディレクトリ (空なら `targetDir`) |
| `c42check.proto.syncOnRun` | `false` | 実行時 (段階 0) にプロトタイプを同期 (プレビューなし) |
| `c42check.proto.syncOnSave` | `false` | `.c` の保存時にプロトタイプを同期 (プレビューなし) |
| `c42check.debug.cwd` / `.terminal` | `${workspaceFolder}` / `integrated` | launch 構成に反映 |
| `c42check.checks` | (全項目。TSan / MSan / CBMC / Frama-C のみ `false`) | チェックボックスの状態 (View から変更すると保存される) |

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
| `samples/bug-tsan` | 2 スレッドが同じ変数を同期なしで更新 (データ競合) | TSan だけが fail (ASan / MSan は pass) |
| `samples/bug-msan` | 初期化していないヒープ領域の読み取り | MSan が fail |
| `samples/proto-ok` | `src/` 以下の複数ファイル (static 関数・関数ポインタ引数・`unsigned long long` を含む) と、マーカーつきのヘッダ `includes/proj.h` | 「ヘッダにプロトタイプを反映」で、norminette を通るヘッダができ、プロジェクトがコンパイルできる |

実機での確認手順 (F5、依存拡張の導入) は [docs/verification.md](docs/verification.md) を参照してください。

## 開発

Node.js 22 以上が必要です (`.nvmrc`、`package.json` の `engines`)。

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # esbuild で dist/extension.js に bundle
npm test            # 95 件。実際のツール (norminette / clang / valgrind など) があれば使い、無ければ該当項目は skip
npm run package     # .vsix を作る
```

構成: `src/core/` は VS Code に依存しない純 TypeScript (検証の実行、parser、`compile_commands.json` 生成、launch 構成の生成) で、
`src/ui/` が VS Code との接続 (TreeView、Task、Diagnostics、Output Channel) です。実行時の依存パッケージはありません。

## 既知の制限

- scan-build は、Makefile が `CC` を固定していても `make CC="$CC"` で上書きして ccc-analyzer を通しますが、レシピがコンパイラを直接 (`gcc` と) 書いている場合は解析されません。
  元のツリーを汚さないよう、`.42check/scan-build/src` にコピーして `make -B` で全ビルドします。
- GUI や無限ループの課題 (so_long、cub3d など) は、制限時間を超えるため動的チェックが skip になります。その項目のチェックを外してください。
- ツールの版が違うと検出結果が変わりえます。開発時の確認は clang 18 / gcc 13 / valgrind 3.22 で行っており、校舎の `-12` 系での確認は未実施です。
- `gcc -fanalyzer` (校舎の gcc-12 で確認) は、`samples/bug-leak` のメモリリークを見逃しました。同じリークを clang-tidy と scan-build、ASan、valgrind は検出しています。
  gcc の analyzer の検出範囲の限界と思われます。`gcc -fanalyzer` が pass でも、他の項目が fail することがあります。
- 校舎の clang-12 に sanitizer のランタイム (compiler-rt) が入っていない、または TSan / MSan が動かない場合は、その項目は skip になります (校舎の `-12` 系での TSan / MSan と、ctags は未確認です)。
- ctags は Universal Ctags でなければ使えません。校舎に無い場合は、プロトタイプの反映は skip になります (検証 本体には影響しません)。
