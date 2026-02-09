[Setup]
AppId={{ECHO-MUSIC-DESKTOP-APP}}
AppName=EchoMusic
AppVersion=1.0.0
AppPublisher=EchoMusic Team
DefaultDirName={autopf}\EchoMusic
DefaultGroupName=EchoMusic
OutputDir=.
OutputBaseFilename=EchoMusic-Windows-Setup
SetupIconFile=windows\runner\resources\app_icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "build\windows\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\EchoMusic"; Filename: "{app}\echomusic.exe"
Name: "{commondesktop}\EchoMusic"; Filename: "{app}\echomusic.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\echomusic.exe"; Description: "{cm:LaunchProgram,EchoMusic}"; Flags: nowait postinstall skipifsilent