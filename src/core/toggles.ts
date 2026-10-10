/**
 * View の「設定」グループのチェックボックスと、settings.json の対応キー (c42check.<key>) の対応表。
 * 真偽値でない設定 (failFast は "stage" | "step") も、チェック状態との相互変換をここで持つ。
 */
export interface ToggleDef {
  id: string;
  label: string;
  /** `c42check.` を除いた設定キー */
  key: string;
  description: string;
  /** 設定が未指定のときのチェック状態 */
  defaultValue: boolean;
  fromConfig(value: unknown): boolean;
  toConfig(checked: boolean): unknown;
}

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

export const TOGGLES: ToggleDef[] = [
  {
    id: 'failFastStep',
    label: 'failFast を step にする',
    key: 'failFast',
    description: 'ON: 最初に失敗した項目で止める ("step") / OFF: 同じ段階の全項目を実行してから止める ("stage")',
    defaultValue: false,
    fromConfig: (v) => v === 'step',
    toConfig: (checked) => (checked ? 'step' : 'stage'),
  },
  {
    id: 'debugSanitizer',
    label: 'ASan 付きデバッグ',
    key: 'debug.sanitizer',
    description: 'デバッグ用ビルド (F5) に ASan + UBSan を付ける',
    defaultValue: false,
    fromConfig: (v) => bool(v, false),
    toConfig: (checked) => checked,
  },
  {
    id: 'useMakeCheckTarget',
    label: 'Makefile の check ターゲットを使う',
    key: 'useMakeCheckTarget',
    description: 'Makefile に check ターゲットがあれば、scan-build は make の代わりに make check を包んで実行する',
    defaultValue: false,
    fromConfig: (v) => bool(v, false),
    toConfig: (checked) => checked,
  },
  {
    id: 'protoSyncOnRun',
    label: '実行時 (段階 0) にプロトタイプを同期',
    key: 'proto.syncOnRun',
    description: '実行の段階 0 で、ヘッダの auto prototypes の区間を更新する (差分プレビューは出ない)',
    defaultValue: false,
    fromConfig: (v) => bool(v, false),
    toConfig: (checked) => checked,
  },
  {
    id: 'protoSyncOnSave',
    label: '保存時にプロトタイプを同期',
    key: 'proto.syncOnSave',
    description: '.c を保存したときに、ヘッダの auto prototypes の区間を更新する (差分プレビューは出ない)',
    defaultValue: false,
    fromConfig: (v) => bool(v, false),
    toConfig: (checked) => checked,
  },
];
