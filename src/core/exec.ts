import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 出力の保持上限 (超えた分は捨てる) */
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string; // stdout と stderr を到着順に連結
  timedOut: boolean;
  aborted: boolean;
  /** spawn 自体の失敗 (ENOENT など) */
  error?: string;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * shell を介さずにコマンドを実行する。stdin は /dev/null。
 * 子プロセスは独自の process group で起動し、timeout / abort 時は group ごと kill する
 * (make や scan-build が起動した孫プロセスを残さないため)。
 */
export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    let output = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (r: Omit<ExecResult, 'output' | 'timedOut' | 'aborted'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (truncated) output += '\n[c42check] 出力が上限を超えたため以降を省略しました\n';
      resolve({ ...r, output, timedOut, aborted });
    };

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      resolve({ code: null, signal: null, output: '', timedOut: false, aborted: false, error: String(e) });
      return;
    }

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 既に終了している */
        }
      }
    };

    const onData = (chunk: Buffer) => {
      if (output.length >= maxBytes) {
        truncated = true;
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => finish({ code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}
