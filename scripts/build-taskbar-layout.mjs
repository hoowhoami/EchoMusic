import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const framework = join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
  );
  const compiler = join(framework, 'csc.exe');
  if (!existsSync(compiler))
    throw new Error('Windows .NET Framework C# compiler is required for the taskbar layout helper');
  const destination = resolve(root, 'build', 'taskbar-layout');
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
  if (result.status !== 0) process.exit(result.status || 1);
}
