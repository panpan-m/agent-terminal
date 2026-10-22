; Inno Setup script for agent-terminal (Windows x64).
;
; Build prerequisites:
;   1. pwsh -File packaging/pyinstaller/build.ps1
;   2. iscc packaging\windows\agent-terminal.iss
;
; The installer creates C:\ProgramData\agent-terminal\config.toml on first run,
; writes the one-time tokens next to it, registers the service and starts
; it. Uninstall stops/removes the service but keeps ProgramData unless the user
; chooses to delete it.

#define AppName "Agent Terminal"
#define AppVersion "0.1.0"
#define AppPublisher "agent-terminal contributors"
#define ServiceName "agent-terminal"

[Setup]
AppId={{006461B8-CA66-475F-A2A9-0B3D4005374C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\agent-terminal
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=agent-terminal-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
LicenseFile=..\..\LICENSE
MinVersion=10.0

[Files]
Source: "..\..\dist\agent-terminal\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\agent-terminal"; Permissions: users-modify
Name: "{commonappdata}\agent-terminal\logs"; Permissions: users-modify
Name: "{commonappdata}\agent-terminal\transcripts"; Permissions: users-modify

[Icons]
Name: "{group}\Open agent-terminal admin"; Filename: "http://127.0.0.1:8765/"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\agent-terminal.exe"; Parameters: "init --dir ""{commonappdata}\agent-terminal"" --credentials-out ""{commonappdata}\agent-terminal\first-run-credentials.json"""; StatusMsg: "Creating configuration and credentials..."; Flags: runhidden waituntilterminated; Check: ConfigMissing
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-service.ps1"""; StatusMsg: "Registering Windows service..."; Flags: runhidden waituntilterminated
Filename: "{app}\agent-terminal.exe"; Parameters: "doctor --config ""{commonappdata}\agent-terminal\config.toml"""; StatusMsg: "Checking the installation..."; Flags: runhidden waituntilterminated
Filename: "http://127.0.0.1:8765/"; Description: "Open the admin UI"; Flags: shellexec nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "delete {#ServiceName}"; Flags: runhidden waituntilterminated

[Code]
function ConfigMissing: Boolean;
begin
  Result := not FileExists(ExpandConstant('{commonappdata}\agent-terminal\config.toml'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  CredPath: string;
begin
  if CurStep = ssPostInstall then
  begin
    CredPath := ExpandConstant('{commonappdata}\agent-terminal\first-run-credentials.json');
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
    if MsgBox('Delete the configuration, transcripts and tokens in C:\ProgramData\agent-terminal?',
              mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ExpandConstant('{commonappdata}\agent-terminal'), True, True, True);
  end;
end;
