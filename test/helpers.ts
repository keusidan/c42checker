import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContext } from '../src/core/context';
import { DEFAULT_SETTINGS, type Context, type Settings } from '../src/core/types';
import { detectTools } from '../src/core/tools';

export const REPO = process.env.C42_REPO ?? path.resolve(__dirname, '..');

/** samples/<name> を一時ディレクトリにコピーして Context を作る。 */
export function sampleContext(
  name: string,
  overrides: Partial<Settings> = {},
  remove: string[] = [],
): { ctx: Context; dir: string; logs: Map<string, string>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c42-${name}-`));
  fs.cpSync(path.join(REPO, 'samples', name), dir, { recursive: true });
  for (const r of remove) fs.rmSync(path.join(dir, r), { recursive: true, force: true });
  const settings: Settings = { ...DEFAULT_SETTINGS, normExclude: [], ...overrides, checks: { ...DEFAULT_SETTINGS.checks, ...overrides.checks } };
  // .vscode/settings.json の c42check.* を反映 (拡張が VS Code から読むものの代わり)
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.vscode', 'settings.json'), 'utf8')) as Record<string, unknown>;
    if (typeof raw['c42check.mainFile'] === 'string' && overrides.mainFile === undefined) {
      settings.mainFile = raw['c42check.mainFile'];
    }
  } catch {
    /* 設定なし */
  }
  const logs = new Map<string, string>();
  const ctx = createContext({
    root: dir,
    settings,
    tools: detectTools(),
    io: { log: (ch, text) => logs.set(ch, (logs.get(ch) ?? '') + text) },
  });
  return { ctx, dir, logs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
