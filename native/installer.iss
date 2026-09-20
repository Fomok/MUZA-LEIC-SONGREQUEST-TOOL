; Song Bot — native app installer (Inno Setup)
; Built by GitHub Actions from the "stage" folder at the repo root.

[Setup]
AppId={{6E2C9A41-8F3B-4C7D-9B1E-3A5D2F8C0B77}
AppName=Song Bot
AppVersion=2.0.0
AppPublisher=Fomok
DefaultDirName={localappdata}\Programs\Song Bot
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-native
OutputBaseFilename=Song-Bot-Setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\Song Bot.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "..\stage\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Song Bot"; Filename: "{app}\Song Bot.exe"
Name: "{autodesktop}\Song Bot"; Filename: "{app}\Song Bot.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Song Bot.exe"; Description: "Launch Song Bot"; Flags: nowait postinstall skipifsilent

; Settings/playlists live in %APPDATA%\twitch-song-bot and are never touched by install or uninstall.
