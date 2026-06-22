import { app } from 'electron';
import { mkdirSync } from 'fs';
import { isAbsolute, join, normalize, relative, resolve } from 'path';

export const getPluginRoot = () => join(app.getPath('userData'), 'plugins');

export const ensurePluginRoot = () => {
  const root = getPluginRoot();
  mkdirSync(root, { recursive: true });
  return root;
};

export const isPathInside = (parent: string, target: string) => {
  const diff = relative(parent, target);
  return diff === '' || (!!diff && !diff.startsWith('..') && !isAbsolute(diff));
};

export const resolvePluginFile = (directory: string, fileName: unknown) => {
  const normalizedFileName = normalize(String(fileName ?? '').trim());
  if (!normalizedFileName || normalizedFileName.startsWith('..')) return '';
  const fullPath = resolve(directory, normalizedFileName);
  if (!isPathInside(resolve(directory), fullPath)) return '';
  return fullPath;
};

export const toPortableRelativePath = (parent: string, target: string) =>
  relative(parent, target).replace(/\\/g, '/');
