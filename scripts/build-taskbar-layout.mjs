import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'build', 'taskbar-layout');

try {
  if (process.platform === 'win32') {
    const framework = join(
      process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
    );
    const compiler = join(framework, 'csc.exe');
    if (!existsSync(compiler))
      throw new Error(
        `csc.exe not found: ${compiler}. Install/enable Windows .NET Framework 4.x with WPF assemblies.`,
      );
    mkdirSync(destination, { recursive: true });
    const result = spawnSync(
      compiler,
      [
        '/nologo',
        '/target:exe',
        '/optimize+',
        '/platform:anycpu',
        `/out:${join(destination, 'EchoMusic.TaskbarLayout.exe')}`,
        `/reference:${join(framework, 'WPF', 'UIAutomationClient.dll')}`,
        `/reference:${join(framework, 'WPF', 'UIAutomationTypes.dll')}`,
        `/reference:${join(framework, 'WPF', 'WindowsBase.dll')}`,
        `/reference:${join(framework, 'System.Web.Extensions.dll')}`,
        join(root, 'native', 'taskbar-layout', 'TaskbarLayout.cs'),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  }
} finally {
  // Only remove an empty output directory, including one left on another OS.
  // Never recursively remove it: successful builds must remain for packaging.
  try {
    rmdirSync(destination);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}
