#ifndef AppVersion
#define AppVersion GetFileVersion(BuildDir + "\EchoMusic.exe")
#endif
#ifndef AppArch
#define AppArch "x64"
#endif
#ifndef BuildDir
#define BuildDir "build\\windows\\x64\\runner\\Release"
#endif

[Setup]
AppId={{ECHO-MUSIC-DESKTOP-APP}}
AppName=EchoMusic
AppVersion={#AppVersion}
AppPublisher=EchoMusic Team
DefaultDirName={autopf}\EchoMusic
DefaultGroupName=EchoMusic
OutputDir=.
OutputBaseFilename=EchoMusic-Windows-Setup-{#AppArch}
SetupIconFile=windows\runner\resources\app_icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed={#AppArch}
ArchitecturesInstallIn64BitMode={#AppArch}
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\EchoMusic"; Filename: "{app}\EchoMusic.exe"
Name: "{commondesktop}\EchoMusic"; Filename: "{app}\EchoMusic.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\EchoMusic.exe"; Description: "{cm:LaunchProgram,EchoMusic}"; Flags: nowait postinstall skipifsilent

[Code]
const
  VCRedistRegistryPath = 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\{#AppArch}';

function IsVCRedistInstalled: Boolean;
var
  Installed: Cardinal;
begin
  Result := False;
  if RegQueryDWordValue(HKEY_LOCAL_MACHINE, VCRedistRegistryPath, 'Installed', Installed) then
  begin
    Result := (Installed = 1);
  end;
end;

function IsProcessRunning(const ProcessName: String): Boolean;
var
  ResultCode: Integer;
begin
  ResultCode := -1;
  Result := Exec(
    ExpandConstant('{sys}\cmd.exe'),
    '/C tasklist /FI "IMAGENAME eq ' + ProcessName + '" | find /I "' + ProcessName + '" >NUL',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) and (ResultCode = 0);

  if Result then
  begin
    Log('Detected running process: ' + ProcessName);
  end;
end;

procedure ForceKillProcess(const ProcessName: String);
var
  ResultCode: Integer;
begin
  ResultCode := -1;
  Log('Attempting to close process: ' + ProcessName);
  Exec(
    ExpandConstant('{sys}\taskkill.exe'),
    '/F /IM ' + ProcessName + ' /T',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  Log(Format('taskkill exit code for %s: %d', [ProcessName, ResultCode]));
end;

procedure RegisterExtraCloseApplicationsResources;
begin
  RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\server\app_win.exe'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Retry: Integer;
begin
  Result := '';

  if (not IsProcessRunning('EchoMusic.exe')) and
     (not IsProcessRunning('echomusic.exe')) and
     (not IsProcessRunning('app_win.exe')) then
  begin
    Exit;
  end;

  if not WizardSilent then
  begin
    if MsgBox(
      '检测到 EchoMusic 或其后台服务仍在运行。' #13#10 #13#10 +
      '安装程序需要先关闭以下进程后才能继续：' #13#10 +
      '- EchoMusic.exe / echomusic.exe' #13#10 +
      '- app_win.exe' #13#10 #13#10 +
      '点击“是”后将自动关闭它们并继续安装。' #13#10 +
      '如果你正在播放音乐，请先保存好当前操作。',
      mbConfirmation,
      MB_YESNO
    ) <> IDYES then
    begin
      Result := '请先完全退出 EchoMusic（包括托盘和后台 server）后再重新运行安装程序。';
      Exit;
    end;
  end;

  ForceKillProcess('EchoMusic.exe');
  ForceKillProcess('echomusic.exe');
  ForceKillProcess('app_win.exe');

  for Retry := 0 to 9 do
  begin
    if (not IsProcessRunning('EchoMusic.exe')) and
       (not IsProcessRunning('echomusic.exe')) and
       (not IsProcessRunning('app_win.exe')) then
    begin
      Log('All EchoMusic processes have been closed.');
      Exit;
    end;
    Sleep(500);
  end;

  Result := '无法关闭正在运行的 EchoMusic 或后台服务。请在任务管理器中结束相关进程后重试安装。';
end;

function InitializeSetup: Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not IsVCRedistInstalled then
  begin
    if MsgBox('EchoMusic 需要 Microsoft Visual C++ Redistributable 运行环境才能正常播放音频。' #13#10 #13#10 '检测到您的系统尚未安装该组件，是否立即打开浏览器下载？', mbConfirmation, MB_YESNO) = idYes then
    begin
      ShellExec('open', 'https://aka.ms/vs/17/release/vc_redist.x64.exe', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    end;
  end;
end;
