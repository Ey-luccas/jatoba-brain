import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export async function safeRepositoryPath(relativePath: string) {
  const root = await realpath(config.workspaceDir);
  const target = await realpath(path.resolve(root,relativePath));
  if (target !== root && !target.startsWith(root+path.sep)) throw new Error('Repository path escapes WORKSPACE_DIR');
  return target;
}
