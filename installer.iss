[Setup]
AppId={{ECHO-MUSIC-DESKTOP-APP}}
AppName=EchoMusic
AppVersion=1.0.3
AppPublisher=EchoMusic Team
DefaultDirName={autopf}\EchoMusic
DefaultGroupName=EchoMusic
OutputDir=.
OutputBaseFilename=EchoMusic-Windows-Setup
SetupIconFile=windows\runner\resources\app_icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\EchoMusic"; Filename: "{app}\echomusic.exe"
Name: "{commondesktop}\EchoMusic"; Filename: "{app}\echomusic.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\echomusic.exe"; Description: "{cm:LaunchProgram,EchoMusic}"; Flags: nowait postinstall skipifsilent

[Code]
function IsVCRedistInstalled: Boolean;
var
  Installed: Cardinal;
begin
  Result := False;
  if RegQueryDWordValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) then
  begin
    Result := (Installed = 1);
  end;
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