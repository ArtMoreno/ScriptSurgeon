; ScriptSurgeon Windows installer.
; Build with:
;   ISCC.exe /DAppVersion=2026.08.21 /DBuildRoot=<absolute-path-to-dist> installer\ScriptSurgeon.iss

#define AppName "ScriptSurgeon"
#define AppPublisher "ArtMoreno"
#define AppURL "https://github.com/ArtMoreno/ScriptSurgeon"
#define AppExeName "ScriptSurgeon.exe"

#ifndef AppVersion
  #define AppVersion "dev"
#endif

#ifndef BuildRoot
  #define BuildRoot "..\dist\ScriptSurgeon"
#endif

[Setup]
AppId={{BF44F0B4-BB10-4939-AFF1-8F6427414B0A}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases/latest
DefaultDirName={autopf}\ScriptSurgeon
DefaultGroupName=ScriptSurgeon
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
InfoBeforeFile=..\THIRD_PARTY_NOTICES.md
OutputDir=..\release
OutputBaseFilename=ScriptSurgeon-Setup-{#AppVersion}-windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; This desktop app writes only to the current user's profile and needs no
; elevated service, registry, or shared-file installation. A per-user install
; keeps updates and the first launch free of an avoidable UAC prompt.
PrivilegesRequired=lowest
UninstallDisplayName=ScriptSurgeon
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; The package payload deliberately contains no writable project data. The
; uninstaller removes only installer-owned files, leaving projects in place.
Source: "{#BuildRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\ScriptSurgeon"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\ScriptSurgeon"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch ScriptSurgeon"; Flags: nowait postinstall skipifsilent
