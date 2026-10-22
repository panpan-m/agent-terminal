; Per-user desktop installer for tio-server (Windows x64).
;
; Build:
;   powershell -ExecutionPolicy Bypass -File packaging\pyinstaller\build_desktop.ps1
;   iscc packaging\windows\tio-desktop.iss
;
; This installs a WebView2 desktop window, NOT a Windows service.  The user's
; data lives in %LOCALAPPDATA%\tio-server-desktop and is independent from the
; service install in C:\ProgramData\tio-server.

#define AppName "tio-server Desktop"
#define AppShortName "tio-server"
#define AppVersion "0.1.0"
#define AppPublisher "tio-suite contributors"
#define AppExe "tio-desktop.exe"

[Setup]
AppId={{A3E7F26D-4A6B-4A77-9D0A-6A2B8F9C41D2}
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
OutputBaseFilename=tio-server-desktop-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\..\packaging\windows\tio.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
LicenseFile=..\..\LICENSE
MinVersion=10.0
CloseApplications=yes
SetupLogging=yes

[Files]
Source: "..\..\dist\tio-desktop\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "startup"; Description: "Start tio-server Desktop when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "tio-server Desktop"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: startup

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
    DataDir := ExpandConstant('{localappdata}\tio-server-desktop');
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
