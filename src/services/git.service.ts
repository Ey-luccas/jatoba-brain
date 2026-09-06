import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 5 * 1024 * 1024 });
  return stdout.trim();
}

function safeRepoPath(relativePath: string): string {
  const root = path.resolve(config.workspaceDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Repository path escapes WORKSPACE_DIR');
  }
  return target;
}

export async function gitSnapshot(relativePath: string) {
  const repoPath = safeRepoPath(relativePath);
  const [branch, commit, status, diffStat, diffNames] = await Promise.all([
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['rev-parse', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
    git(repoPath, ['diff', '--stat']),
    git(repoPath, ['diff', '--name-status']),
  ]);

  return {
    repository_path: relativePath,
    branch,
    commit,
    dirty: Boolean(status),
    status: status ? status.split('\n') : [],
    diff_stat: diffStat,
    changed_files: diffNames ? diffNames.split('\n') : [],
    captured_at: new Date().toISOString(),
  };
}
