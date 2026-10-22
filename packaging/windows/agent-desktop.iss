; Per-user desktop installer for agent-terminal (Windows x64).
;
; Build:
;   powershell -ExecutionPolicy Bypass -File packaging\pyinstaller\build_desktop.ps1
;   iscc packaging\windows\agent-desktop.iss
;
; This installs a WebView2 desktop window, NOT a Windows service.  The user's
; data lives in %LOCALAPPDATA%\agent-terminal-desktop and is independent from the
; service install in C:\ProgramData\agent-terminal.

#define AppName "Agent Terminal"
#define AppShortName "agent-terminal"
#define AppVersion "0.1.0"
#define AppPublisher "agent-terminal contributors"
#define AppExe "agent-desktop.exe"

[Setup]
AppId={{E1DD9D41-DA85-4F2D-BC03-84DE3423AA32}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppShortName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=agent-terminal-desktop-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\..\packaging\windows\agent-terminal.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
LicenseFile=..\..\LICENSE
MinVersion=10.0
CloseApplications=yes
SetupLogging=yes

[Files]
Source: "..\..\dist\agent-desktop\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "startup"; Description: "Start agent-terminal Desktop when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "agent-terminal Desktop"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\agent-terminal-desktop');
    if DirExists(DataDir) then
    begin
      if MsgBox('Delete the desktop configuration, transcripts and tokens in:' + #13#10 +
                DataDir + '?' + #13#10#13#10 +
                'Choose No to keep them for a later reinstall.',
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
