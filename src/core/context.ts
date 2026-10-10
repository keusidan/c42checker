import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  collectIncludeDirs,
  definesMain,
  findMakefile,
  scanSources,
} from './sources';
import { detectTools } from './tools';
import { WORK_DIR_NAME } from './workdir';
import type { Context, RunIO, Settings, Tools } from './types';

export interface ContextInput {
  root: string;
  settings: Settings;
  io: RunIO;
  signal?: AbortSignal;
  isFileDirty?: (absPath: string) => boolean;
  /** テスト用: ツール検出を差し替える */
  tools?: Tools;
}

export function createContext(input: ContextInput): Context {
  const { root, settings } = input;
  const targetRoot = path.resolve(root, settings.targetDir);
  const { sources, headers } = scanSources(targetRoot);
  const mainCandidate = settings.mainFile ? path.resolve(root, settings.mainFile) : undefined;
  const mainFile = mainCandidate && fs.existsSync(mainCandidate) ? mainCandidate : undefined;
  return {
    root,
    targetRoot,
    workDir: path.join(root, WORK_DIR_NAME),
    settings,
    tools: input.tools ?? detectTools(),
    sources: sources.filter((s) => s !== mainFile),
    headers,
    includeDirs: collectIncludeDirs(root, targetRoot, headers, settings.includePaths),
    hasMain: sources.some((s) => s !== mainFile && definesMain(s)),
    mainFile,
    hasMakefile: !!findMakefile(targetRoot),
    io: input.io,
    signal: input.signal,
    isFileDirty: input.isFileDirty,
  };
}
