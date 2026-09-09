import { execFile } from 'node:child_process';

export const getShutdownCommand = (platform: string): { file: string; args: string[] } => {
  switch (platform) {
    case 'darwin':
      return {
        file: '/usr/bin/osascript',
        args: ['-e', 'tell application "System Events" to shut down'],
      };
    case 'win32':
      // /t 0 avoids the implicit /f used by Windows for a non-zero delay.
      return { file: 'shutdown.exe', args: ['/s', '/t', '0'] };
    case 'linux':
      return { file: '/usr/bin/systemctl', args: ['poweroff'] };
    default:
      throw new Error('当前系统暂不支持定时关机');
  }
};

export const requestSystemShutdown = (platform = process.platform): Promise<void> => {
  const command = getShutdownCommand(platform);
  return new Promise((resolve, reject) => {
    // Fixed executable/arguments only. Do not use a shell, sudo or force-close applications.
    execFile(command.file, command.args, { windowsHide: true, timeout: 30_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};
