import { app, dialog, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import { extname } from 'path';
import type {
  EchoPluginDescriptor,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
} from '../../shared/plugins';
import { getKvStorage } from '../storage/kv';
import log from '../logger';
import {
  BLOCKED_PLUGIN_PROCESS_ENV_KEYS,
  MAX_PLUGIN_PROCESS_ARGS,
  MAX_PLUGIN_PROCESS_ARG_LENGTH,
  MAX_PLUGIN_PROCESS_ENV_ENTRIES,
  MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH,
  PLUGIN_PROCESS_CONSENTS_KEY,
  WINDOWS_EXECUTABLE_EXTENSIONS,
  normalizePluginId,
} from './common';
import { isPathInside, resolvePluginFile, toPortableRelativePath } from './path';

type PluginProcessConsent = {
  pluginId: string;
  pluginVersion: string;
  executable: string;
  executableHash: string;
  grantedAt: number;
};

type PluginProcessConsents = Record<string, PluginProcessConsent>;

type PluginProcessRecord = {
  pluginId: string;
  executable: string;
  child: ChildProcess;
  startedAt: number;
};

type PluginProcessApiOptions = {
  findPlugin: (pluginId: string) => EchoPluginDescriptor | null;
  getPluginCompatibilityError: (plugin: EchoPluginDescriptor) => string;
  getPluginSafeMode: () => boolean;
};

const pluginProcesses = new Map<number, PluginProcessRecord>();

const pathExists = async (filePath: string) => {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const hashFileSha256 = async (filePath: string) =>
  createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');

const normalizePluginProcessArgs = (args: unknown) => {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) throw new Error('进程参数必须是字符串数组');
  if (args.length > MAX_PLUGIN_PROCESS_ARGS) {
    throw new Error(`进程参数不能超过 ${MAX_PLUGIN_PROCESS_ARGS} 个`);
  }

  return args.map((arg) => {
    if (typeof arg !== 'string') throw new Error('进程参数必须是字符串数组');
    if (arg.includes('\0')) throw new Error('进程参数不能包含空字符');
    if (arg.length > MAX_PLUGIN_PROCESS_ARG_LENGTH) {
      throw new Error(`单个进程参数不能超过 ${MAX_PLUGIN_PROCESS_ARG_LENGTH} 个字符`);
    }
    return arg;
  });
};

const isBlockedPluginProcessEnvKey = (key: string) =>
  BLOCKED_PLUGIN_PROCESS_ENV_KEYS.has(key.toUpperCase());

const buildPluginProcessEnv = (
  plugin: EchoPluginDescriptor,
  pluginRoot: string,
  customEnv: unknown,
) => {
  const env = Object.entries(process.env).reduce<Record<string, string>>(
    (nextEnv, [key, value]) => {
      if (value !== undefined && !isBlockedPluginProcessEnvKey(key)) nextEnv[key] = value;
      return nextEnv;
    },
    {},
  );
  env.ECHOMUSIC_PLUGIN_ID = plugin.id;
  env.ECHOMUSIC_PLUGIN_DIR = pluginRoot;

  if (customEnv === undefined || customEnv === null) return env;
  if (typeof customEnv !== 'object' || Array.isArray(customEnv)) {
    throw new Error('进程环境变量必须是对象');
  }

  const entries = Object.entries(customEnv as Record<string, unknown>);
  if (entries.length > MAX_PLUGIN_PROCESS_ENV_ENTRIES) {
    throw new Error(`进程环境变量不能超过 ${MAX_PLUGIN_PROCESS_ENV_ENTRIES} 项`);
  }

  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名非法: ${rawKey}`);
    if (isBlockedPluginProcessEnvKey(key)) continue;
    if (rawValue === undefined || rawValue === null) {
      delete env[key];
      continue;
    }

    const value = String(rawValue);
    if (value.includes('\0')) throw new Error(`环境变量 ${key} 不能包含空字符`);
    if (value.length > MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH) {
      throw new Error(`环境变量 ${key} 不能超过 ${MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH} 个字符`);
    }
    env[key] = value;
  }

  return env;
};

const resolvePluginProcessPath = async (
  plugin: EchoPluginDescriptor,
  value: unknown,
  options: { kind: 'file' | 'directory'; label: string },
) => {
  const input = String(value ?? '').trim();
  if (!input) throw new Error(`${options.label}不能为空`);
  if (input.includes('\0')) throw new Error(`${options.label}不能包含空字符`);

  const resolvedPath = resolvePluginFile(plugin.directory, input);
  if (!resolvedPath) throw new Error(`${options.label}必须位于插件目录内`);
  if (!(await pathExists(resolvedPath))) throw new Error(`${options.label}不存在`);

  const pluginRoot = await fs.realpath(plugin.directory);
  const realPath = await fs.realpath(resolvedPath);
  if (!isPathInside(pluginRoot, realPath)) throw new Error(`${options.label}必须位于插件目录内`);

  const stats = await fs.stat(realPath);
  if (options.kind === 'file' && !stats.isFile()) throw new Error(`${options.label}必须是文件`);
  if (options.kind === 'directory' && !stats.isDirectory()) {
    throw new Error(`${options.label}必须是文件夹`);
  }

  return { pluginRoot, realPath, stats };
};

const resolvePluginProcessLaunch = async (plugin: EchoPluginDescriptor, options: unknown) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('进程启动参数必须是对象');
  }

  const launchOptions = options as PluginProcessLaunchOptions;
  const executable = await resolvePluginProcessPath(plugin, launchOptions.executable, {
    kind: 'file',
    label: '可执行程序路径',
  });
  const executableExt = extname(executable.realPath).toLowerCase();

  if (process.platform === 'win32' && !WINDOWS_EXECUTABLE_EXTENSIONS.has(executableExt)) {
    throw new Error('Windows 插件进程只支持 .exe 或 .com 可执行文件');
  }
  if (process.platform !== 'win32' && (executable.stats.mode & 0o111) === 0) {
    throw new Error('可执行程序缺少执行权限');
  }

  const cwd =
    launchOptions.cwd === undefined || launchOptions.cwd === null || launchOptions.cwd === ''
      ? { pluginRoot: executable.pluginRoot, realPath: executable.pluginRoot }
      : await resolvePluginProcessPath(plugin, launchOptions.cwd, {
          kind: 'directory',
          label: '工作目录',
        });

  if (!isPathInside(executable.pluginRoot, cwd.realPath)) {
    throw new Error('工作目录必须位于插件目录内');
  }

  const args = normalizePluginProcessArgs(launchOptions.args);
  const env = buildPluginProcessEnv(plugin, executable.pluginRoot, launchOptions.env);
  const executableRelativePath = toPortableRelativePath(executable.pluginRoot, executable.realPath);

  return {
    executablePath: executable.realPath,
    executableRelativePath,
    executableHash: await hashFileSha256(executable.realPath),
    cwd: cwd.realPath,
    args,
    env,
  };
};

const getPluginProcessConsents = (): PluginProcessConsents => {
  const saved = getKvStorage().get<PluginProcessConsents>(PLUGIN_PROCESS_CONSENTS_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};

  return Object.entries(saved).reduce<PluginProcessConsents>((consents, [key, consent]) => {
    if (!consent || typeof consent !== 'object') return consents;
    const normalizedPluginId = normalizePluginId(consent.pluginId);
    const executable = String(consent.executable || '').trim();
    const executableHash = String(consent.executableHash || '').trim();
    if (!normalizedPluginId || !executable || !/^[a-f0-9]{64}$/i.test(executableHash)) {
      return consents;
    }
    consents[key] = {
      pluginId: normalizedPluginId,
      pluginVersion: String(consent.pluginVersion || ''),
      executable,
      executableHash: executableHash.toLowerCase(),
      grantedAt: Number(consent.grantedAt) || Date.now(),
    };
    return consents;
  }, {});
};

const setPluginProcessConsents = (consents: PluginProcessConsents) => {
  getKvStorage().set(PLUGIN_PROCESS_CONSENTS_KEY, consents);
};

const getPluginProcessConsentKey = (pluginId: string, executable: string) =>
  `${normalizePluginId(pluginId)}:${executable}`;

const hasPluginProcessConsent = (
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  const consent = getPluginProcessConsents()[getPluginProcessConsentKey(plugin.id, executable)];
  return (
    consent?.pluginId === plugin.id &&
    consent.pluginVersion === plugin.version &&
    consent.executable === executable &&
    consent.executableHash === executableHash
  );
};

const rememberPluginProcessConsent = (
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  const consents = getPluginProcessConsents();
  consents[getPluginProcessConsentKey(plugin.id, executable)] = {
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    executable,
    executableHash,
    grantedAt: Date.now(),
  };
  setPluginProcessConsents(consents);
};

const confirmPluginProcessLaunch = async (
  owner: BrowserWindow | null | undefined,
  plugin: EchoPluginDescriptor,
  executable: string,
  executableHash: string,
) => {
  if (hasPluginProcessConsent(plugin, executable, executableHash)) return true;

  const options = {
    type: 'warning' as const,
    title: '允许插件启动本地程序？',
    message: `${plugin.name} 想启动插件目录内的可执行程序`,
    detail: [
      `插件: ${plugin.name} (${plugin.id})`,
      `程序: ${executable}`,
      '',
      '该文件位于插件目录内，但启动后的程序将拥有与你当前账户相同的系统权限，可能访问本机文件、网络和系统资源。仅在你信任该插件来源时允许。',
      '插件更新、版本变化或程序文件变化后会重新请求确认。',
    ].join('\n'),
    buttons: ['允许并记住', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    normalizeAccessKeys: true,
  };
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);

  if (result.response !== 0) return false;
  rememberPluginProcessConsent(plugin, executable, executableHash);
  return true;
};

export const clearPluginProcessConsents = (pluginId: string) => {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) return;
  const consents = getPluginProcessConsents();
  let changed = false;
  for (const [key, consent] of Object.entries(consents)) {
    if (consent.pluginId !== normalizedPluginId) continue;
    delete consents[key];
    changed = true;
  }
  if (changed) setPluginProcessConsents(consents);
};

export const createPluginProcessApi = ({
  findPlugin,
  getPluginCompatibilityError,
  getPluginSafeMode,
}: PluginProcessApiOptions) => {
  const terminatePluginProcess = (pluginId: string, pid: number): PluginProcessTerminateResult => {
    const normalizedPluginId = normalizePluginId(pluginId);
    const normalizedPid = Math.trunc(Number(pid));
    if (!normalizedPluginId || !Number.isFinite(normalizedPid) || normalizedPid <= 0) {
      return { ok: false, error: '进程 ID 非法' };
    }

    const record = pluginProcesses.get(normalizedPid);
    if (!record || record.pluginId !== normalizedPluginId) {
      return { ok: false, error: '插件进程不存在' };
    }

    try {
      const terminated = record.child.kill();
      if (terminated) pluginProcesses.delete(normalizedPid);
      return { ok: true, pid: normalizedPid, terminated };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '插件进程终止失败',
      };
    }
  };

  const terminatePluginProcesses = (pluginId?: string): Promise<void> => {
    const normalizedPluginId = pluginId ? normalizePluginId(pluginId) : '';
    const terminationPromises: Promise<void>[] = [];

    for (const [pid, record] of Array.from(pluginProcesses.entries())) {
      if (normalizedPluginId && record.pluginId !== normalizedPluginId) continue;

      const terminationPromise = new Promise<void>((resolve) => {
        const cleanup = () => {
          pluginProcesses.delete(pid);
          resolve();
        };

        if (record.child.exitCode !== null || record.child.killed) {
          cleanup();
          return;
        }

        const timeout = setTimeout(() => {
          log.warn('[Plugin] Process termination timeout, forcing cleanup', {
            pluginId: record.pluginId,
            pid,
          });
          cleanup();
        }, 5000);

        const onExit = () => {
          clearTimeout(timeout);
          cleanup();
        };

        record.child.once('exit', onExit);
        record.child.once('error', onExit);

        try {
          record.child.kill();
        } catch (error) {
          log.warn('[Plugin] Failed to terminate plugin process', {
            pluginId: record.pluginId,
            pid,
            error,
          });
          clearTimeout(timeout);
          cleanup();
        }
      });

      terminationPromises.push(terminationPromise);
    }

    return Promise.all(terminationPromises).then(() => undefined);
  };

  const launchPluginProcess = async (
    pluginId: string,
    options: PluginProcessLaunchOptions,
    owner?: BrowserWindow | null,
  ): Promise<PluginProcessLaunchResult> => {
    if (getPluginSafeMode()) return { ok: false, error: '插件安全模式已开启' };

    const plugin = findPlugin(pluginId);
    if (!plugin) return { ok: false, error: '插件不存在' };
    if (plugin.invalid) return { ok: false, error: plugin.error || '插件无效' };

    const compatibilityError = getPluginCompatibilityError(plugin);
    if (compatibilityError) return { ok: false, error: compatibilityError };
    if (!plugin.enabled) return { ok: false, error: '插件未启用' };
    if (plugin.manifest.capabilities?.process !== true) {
      return { ok: false, error: '插件未声明本地进程能力' };
    }

    try {
      const launch = await resolvePluginProcessLaunch(plugin, options);
      const allowed = await confirmPluginProcessLaunch(
        owner,
        plugin,
        launch.executableRelativePath,
        launch.executableHash,
      );
      if (!allowed) return { ok: false, error: '用户已取消启动本地程序', canceled: true };

      const child = spawn(launch.executablePath, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      const startedAt = Date.now();
      let trackedPid = 0;
      let processFinished = false;
      const forgetProcess = () => {
        processFinished = true;
        if (trackedPid > 0) pluginProcesses.delete(trackedPid);
      };
      child.once('exit', forgetProcess);
      child.once('error', (error) => {
        if (trackedPid > 0) {
          log.warn('[Plugin] Plugin process failed', {
            pluginId: plugin.id,
            executable: launch.executableRelativePath,
            pid: trackedPid,
            error,
          });
        }
        forgetProcess();
      });

      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const onSpawn = () => {
          child.removeListener('error', onError);
          resolveSpawn();
        };
        const onError = (error: Error) => {
          child.removeListener('spawn', onSpawn);
          rejectSpawn(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });

      const pid = Number(child.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        child.kill();
        return { ok: false, error: '插件进程启动失败' };
      }

      trackedPid = pid;
      pluginProcesses.set(pid, {
        pluginId: plugin.id,
        executable: launch.executableRelativePath,
        child,
        startedAt,
      });
      if (processFinished) pluginProcesses.delete(pid);

      return {
        ok: true,
        pid,
        executable: launch.executableRelativePath,
        cwd: launch.cwd,
        startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '插件进程启动失败',
      };
    }
  };

  app.once('before-quit', () => void terminatePluginProcesses());

  return {
    terminatePluginProcess,
    terminatePluginProcesses,
    launchPluginProcess,
    clearPluginProcessConsents,
  };
};
