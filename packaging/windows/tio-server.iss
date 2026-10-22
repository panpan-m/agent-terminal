; Inno Setup script for tio-server (Windows x64).
;
; Build prerequisites:
;   1. pwsh -File packaging/pyinstaller/build.ps1
;   2. iscc packaging\windows\tio-server.iss
;
; The installer creates C:\ProgramData\tio-server\config.toml on first run,
; writes the one-time tokens next to it, registers the service and starts
; it. Uninstall stops/removes the service but keeps ProgramData unless the user
; chooses to delete it.

#define AppName "tio-server"
#define AppVersion "0.1.0"
#define AppPublisher "tio-suite contributors"
#define ServiceName "tio-server"

[Setup]
AppId={{7C1E5C4A-9E3B-4F2A-9B5D-2C8F1F0E6D21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\tio-server
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=tio-server-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
LicenseFile=..\..\LICENSE
MinVersion=10.0

[Files]
Source: "..\..\dist\tio-server\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\tio-server"; Permissions: users-modify
Name: "{commonappdata}\tio-server\logs"; Permissions: users-modify
Name: "{commonappdata}\tio-server\transcripts"; Permissions: users-modify

[Icons]
Name: "{group}\Open tio-server admin"; Filename: "http://127.0.0.1:8765/"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\tio-server.exe"; Parameters: "init --dir ""{commonappdata}\tio-server"" --credentials-out ""{commonappdata}\tio-server\first-run-credentials.json"""; StatusMsg: "Creating configuration and credentials..."; Flags: runhidden waituntilterminated; Check: ConfigMissing
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-service.ps1"""; StatusMsg: "Registering Windows service..."; Flags: runhidden waituntilterminated
Filename: "{app}\tio-server.exe"; Parameters: "doctor --config ""{commonappdata}\tio-server\config.toml"""; StatusMsg: "Checking the installation..."; Flags: runhidden waituntilterminated
Filename: "http://127.0.0.1:8765/"; Description: "Open the admin UI"; Flags: shellexec nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "delete {#ServiceName}"; Flags: runhidden waituntilterminated

[Code]
function ConfigMissing: Boolean;
begin
  Result := not FileExists(ExpandConstant('{commonappdata}\tio-server\config.toml'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  CredPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    CredPath := ExpandConstant('{commonappdata}\tio-server\first-run-credentials.json');
    if FileExists(CredPath) then
      MsgBox('Configuration created.' + #13#10#13#10 +
             'The MCP API token is in:' + #13#10 + CredPath + #13#10#13#10 +
             'Read it, then delete the file.' + #13#10 +
             'Then open http://127.0.0.1:8765/ (no login needed).', mbInformation, MB_OK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox('Delete the configuration, transcripts and tokens in C:\ProgramData\tio-server?',
              mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ExpandConstant('{commonappdata}\tio-server'), True, True, True);
  end;
end;
