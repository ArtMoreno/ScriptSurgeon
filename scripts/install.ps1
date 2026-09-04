[CmdletBinding()]
param(
    [string]$SourceDirectory,
    [string]$InstallDirectory = 'D:\Apps\ScriptCut',
    [switch]$NoDesktopShortcut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SourceDirectory) {
    $SourceDirectory = Join-Path $AppRoot 'dist\ScriptSurgeon'
}
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)

function Assert-DedicatedDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $Root = [IO.Path]::GetPathRoot($Path).TrimEnd([char[]]'\/')
    if ($Path.TrimEnd([char[]]'\/') -eq $Root) {
        throw "$Label must be a dedicated directory, not a drive root: $Path"
    }
}

function Resolve-PayloadPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw "Manifest contains an invalid payload path: $RelativePath"
    }
    $Segments = @($RelativePath.Replace('\', '/').Split('/'))
    $UnsafeSegments = @($Segments | Where-Object { $_ -in @('', '.', '..') })
    if ($Segments.Count -eq 0 -or $UnsafeSegments.Count -gt 0) {
        throw "Manifest contains an unsafe payload path: $RelativePath"
    }
    if ($Segments[0].Equals('Data', [StringComparison]::OrdinalIgnoreCase)) {
        throw "A payload manifest must never own the writable Data directory: $RelativePath"
    }
    $RootPath = [IO.Path]::GetFullPath($Root)
    $RootPrefix = $RootPath.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $Candidate = [IO.Path]::GetFullPath((Join-Path $RootPath ($Segments -join [IO.Path]::DirectorySeparatorChar)))
    if (-not $Candidate.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest payload path escaped its root: $RelativePath"
    }
    return $Candidate
}

function Read-PayloadManifest {
    param(
        [Parameter(Mandatory)][string]$Root,
        [string[]]$AllowedAppNames = @('ScriptSurgeon')
    )
    $ManifestPath = Join-Path $Root 'payload-manifest.json'
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Payload manifest was not found: $ManifestPath"
    }
    try {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Payload manifest is invalid JSON: $ManifestPath"
    }
    $Files = @($Manifest.files)
    $AppName = [string]$Manifest.appName
    if ($Manifest.schemaVersion -ne 1 -or $AllowedAppNames -notcontains $AppName) {
        throw "Payload manifest has an unsupported identity or schema: $ManifestPath"
    }
    if ($Files.Count -eq 0 -or [int]$Manifest.fileCount -ne $Files.Count) {
        throw "Payload manifest has an invalid file count: $ManifestPath"
    }
    return $Manifest
}

function Get-PayloadExecutableName {
    param([Parameter(Mandatory)]$Manifest)
    switch ([string]$Manifest.appName) {
        'ScriptSurgeon' { return 'ScriptSurgeon.exe' }
        'ScriptCut' { return 'ScriptCut.exe' }
        default { throw "Payload manifest has an unsupported application identity: $($Manifest.appName)" }
    }
}

function Test-Payload {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]$Manifest,
        [switch]$RequireExactFileSet
    )
    $Expected = @{}
    foreach ($Entry in @($Manifest.files)) {
        $Relative = [string]$Entry.path
        $Key = $Relative.Replace('\', '/').ToLowerInvariant()
        if ($Expected.ContainsKey($Key)) {
            throw "Payload manifest contains a duplicate path: $Relative"
        }
        $Expected[$Key] = $true
        $File = Resolve-PayloadPath -Root $Root -RelativePath $Relative
        if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
            throw "Payload file is missing: $Relative"
        }
        $Item = Get-Item -LiteralPath $File
        if ([long]$Item.Length -ne [long]$Entry.size) {
            throw "Payload file size does not match the manifest: $Relative"
        }
        $Hash = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($Hash -ne ([string]$Entry.sha256).ToUpperInvariant()) {
            throw "Payload file hash does not match the manifest: $Relative"
        }
    }
    $RequiredExecutable = Get-PayloadExecutableName -Manifest $Manifest
    if (-not $Expected.ContainsKey($RequiredExecutable.ToLowerInvariant())) {
        throw "Payload manifest does not contain $RequiredExecutable."
    }
    if ($RequireExactFileSet) {
        $Prefix = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
        $Actual = @(
            Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
                Where-Object { $_.Name -ne 'payload-manifest.json' } |
                ForEach-Object {
                    $_.FullName.Substring($Prefix.Length).Replace('\', '/').ToLowerInvariant()
                }
        )
        $Unexpected = @($Actual | Where-Object { -not $Expected.ContainsKey($_) })
        if ($Actual.Count -ne $Expected.Count -or $Unexpected.Count -gt 0) {
            throw "Payload directory contains files not described by its manifest: $Root"
        }
    }
}

function Get-PayloadTopLevels {
    param([Parameter(Mandatory)]$Manifest)
    return @(
        @($Manifest.files) |
            ForEach-Object { ([string]$_.path).Replace('\', '/').Split('/')[0] } |
            Where-Object { $_ -and -not $_.Equals('Data', [StringComparison]::OrdinalIgnoreCase) } |
            Sort-Object -Unique
    )
}

Assert-DedicatedDirectory -Path $SourceDirectory -Label 'SourceDirectory'
Assert-DedicatedDirectory -Path $InstallDirectory -Label 'InstallDirectory'
if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
    throw "Build directory not found: $SourceDirectory. Run scripts\build.ps1 first."
}
if ($SourceDirectory.TrimEnd([char[]]'\/').Equals($InstallDirectory.TrimEnd([char[]]'\/'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SourceDirectory and InstallDirectory must be different.'
}

$SourceManifest = Read-PayloadManifest -Root $SourceDirectory
Test-Payload -Root $SourceDirectory -Manifest $SourceManifest -RequireExactFileSet

$TargetExecutables = @(
    [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'ScriptSurgeon.exe')),
    [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'ScriptCut.exe'))
)
$Running = @(
    Get-Process -Name @('ScriptSurgeon', 'ScriptCut') -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $ProcessPath = [IO.Path]::GetFullPath($_.Path)
                @(
                    $TargetExecutables |
                        Where-Object { $_.Equals($ProcessPath, [StringComparison]::OrdinalIgnoreCase) }
                ).Count -gt 0
            } catch {
                # If Windows will not reveal a matching legacy or current process
                # path, do not risk replacing a potentially locked executable.
                $true
            }
        }
)
if ($Running.Count -gt 0) {
    throw 'ScriptSurgeon or legacy ScriptCut is running. Close it before installing or upgrading.'
}

$InstallParent = Split-Path -Parent $InstallDirectory
$InstallLeaf = Split-Path -Leaf $InstallDirectory
if (-not $InstallParent -or -not $InstallLeaf) {
    throw "InstallDirectory could not be safely separated: $InstallDirectory"
}
New-Item -ItemType Directory -Force -Path $InstallParent | Out-Null

$Nonce = [Guid]::NewGuid().ToString('N')
$StageDirectory = Join-Path $InstallParent ".$InstallLeaf.stage.$Nonce"
$RollbackDirectory = Join-Path $InstallParent ".$InstallLeaf.rollback.$Nonce"
Assert-DedicatedDirectory -Path $StageDirectory -Label 'StageDirectory'
Assert-DedicatedDirectory -Path $RollbackDirectory -Label 'RollbackDirectory'

$MovedOld = New-Object System.Collections.Generic.List[string]
$MovedNew = New-Object System.Collections.Generic.List[string]
$SwapStarted = $false

try {
    New-Item -ItemType Directory -Path $StageDirectory | Out-Null
    foreach ($Entry in @($SourceManifest.files)) {
        $Relative = [string]$Entry.path
        $Source = Resolve-PayloadPath -Root $SourceDirectory -RelativePath $Relative
        $Destination = Resolve-PayloadPath -Root $StageDirectory -RelativePath $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
    Copy-Item -LiteralPath (Join-Path $SourceDirectory 'payload-manifest.json') -Destination $StageDirectory -Force
    $StageManifest = Read-PayloadManifest -Root $StageDirectory
    Test-Payload -Root $StageDirectory -Manifest $StageManifest -RequireExactFileSet

    New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
    $DataDirectory = Join-Path $InstallDirectory 'Data'
    New-Item -ItemType Directory -Force -Path (Join-Path $DataDirectory 'logs') | Out-Null

    $OldTopLevels = @('ScriptSurgeon.exe', 'ScriptCut.exe', '_internal', 'payload-manifest.json')
    $OldManifestPath = Join-Path $InstallDirectory 'payload-manifest.json'
    if (Test-Path -LiteralPath $OldManifestPath -PathType Leaf) {
        try {
            $OldManifest = Read-PayloadManifest -Root $InstallDirectory -AllowedAppNames @('ScriptSurgeon', 'ScriptCut')
            $OldTopLevels += Get-PayloadTopLevels -Manifest $OldManifest
        } catch {
            Write-Warning 'The previous payload manifest is damaged; upgrading the known legacy payload only.'
        }
    }
    $OldTopLevels = @($OldTopLevels | Where-Object { $_ -and $_ -ne 'Data' } | Sort-Object -Unique)

    New-Item -ItemType Directory -Path $RollbackDirectory | Out-Null
    $SwapStarted = $true
    foreach ($Name in $OldTopLevels) {
        $OldPath = Join-Path $InstallDirectory $Name
        if (-not (Test-Path -LiteralPath $OldPath)) { continue }
        $RollbackPath = Join-Path $RollbackDirectory $Name
        Move-Item -LiteralPath $OldPath -Destination $RollbackPath
        $MovedOld.Add($Name)
    }

    $NewTopLevels = @((Get-PayloadTopLevels -Manifest $StageManifest) + 'payload-manifest.json' | Sort-Object -Unique)
    foreach ($Name in $NewTopLevels) {
        if ($Name.Equals('Data', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to install a payload that owns Data.'
        }
        $StagedPath = Join-Path $StageDirectory $Name
        if (-not (Test-Path -LiteralPath $StagedPath)) {
            throw "Staged payload item is missing: $Name"
        }
        Move-Item -LiteralPath $StagedPath -Destination (Join-Path $InstallDirectory $Name)
        $MovedNew.Add($Name)
    }

    $InstalledManifest = Read-PayloadManifest -Root $InstallDirectory
    Test-Payload -Root $InstallDirectory -Manifest $InstalledManifest
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDirectory 'Data') -PathType Container)) {
        throw 'The writable Data directory was not preserved.'
    }
} catch {
    $Failure = $_
    if ($SwapStarted) {
        foreach ($Name in $MovedNew) {
            $InstalledPath = Join-Path $InstallDirectory $Name
            if (Test-Path -LiteralPath $InstalledPath) {
                Remove-Item -LiteralPath $InstalledPath -Recurse -Force
            }
        }
        foreach ($Name in $MovedOld) {
            $RollbackPath = Join-Path $RollbackDirectory $Name
            if (Test-Path -LiteralPath $RollbackPath) {
                Move-Item -LiteralPath $RollbackPath -Destination (Join-Path $InstallDirectory $Name)
            }
        }
    }
    foreach ($TemporaryDirectory in @($StageDirectory, $RollbackDirectory)) {
        if (Test-Path -LiteralPath $TemporaryDirectory) {
            try {
                Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
            } catch {
                Write-Warning "Could not clean temporary installer directory $TemporaryDirectory"
            }
        }
    }
    throw $Failure
}

foreach ($TemporaryDirectory in @($StageDirectory, $RollbackDirectory)) {
    if (Test-Path -LiteralPath $TemporaryDirectory) {
        try {
            Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
        } catch {
            Write-Warning "ScriptSurgeon is installed, but temporary directory cleanup failed: $TemporaryDirectory"
        }
    }
}

$InstalledExe = Join-Path $InstallDirectory 'ScriptSurgeon.exe'
try {
    $Desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $Desktop) { throw 'The Windows Desktop directory could not be resolved.' }
    $Shell = New-Object -ComObject WScript.Shell
    if (-not $NoDesktopShortcut) {
        $ShortcutPath = Join-Path $Desktop 'ScriptSurgeon.lnk'
        $Shortcut = $Shell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $InstalledExe
        $Shortcut.WorkingDirectory = $InstallDirectory
        $Shortcut.IconLocation = "$InstalledExe,0"
        $Shortcut.Description = 'ScriptSurgeon local transcript-based audio editor'
        $Shortcut.Save()
        Write-Host "Desktop shortcut created: $ShortcutPath"
    }

    # The legacy shortcut is removed only after the new payload has been
    # installed and verified. If a replacement shortcut was requested, it must
    # also have been saved successfully before the legacy shortcut is touched.
    $LegacyShortcutPath = Join-Path $Desktop 'ScriptCut.lnk'
    if (Test-Path -LiteralPath $LegacyShortcutPath -PathType Leaf) {
        $LegacyShortcut = $Shell.CreateShortcut($LegacyShortcutPath)
        $LegacyTarget = [IO.Path]::GetFullPath([string]$LegacyShortcut.TargetPath)
        $ExpectedLegacyTarget = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'ScriptCut.exe'))
        if ($LegacyTarget.Equals($ExpectedLegacyTarget, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $LegacyShortcutPath -Force
            Write-Host "Legacy desktop shortcut removed: $LegacyShortcutPath"
        } else {
            Write-Warning "A desktop shortcut named ScriptCut.lnk points elsewhere and was preserved: $LegacyTarget"
        }
    }

    try {
        if (-not ('ScriptCut.NativeShell' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ScriptCut
{
    public static class NativeShell
    {
        private const uint SHCNE_ASSOCCHANGED = 0x08000000;
        private const uint SHCNF_IDLIST = 0x0000;
        private const uint SHCNF_FLUSH = 0x1000;

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(
            uint eventId,
            uint flags,
            IntPtr item1,
            IntPtr item2
        );

        public static void RefreshIconCache()
        {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED,
                SHCNF_IDLIST | SHCNF_FLUSH,
                IntPtr.Zero,
                IntPtr.Zero
            );
        }
    }
}
'@
        }
        [ScriptCut.NativeShell]::RefreshIconCache()
        Write-Host 'Windows Shell icon cache refresh requested.'
    } catch {
        Write-Warning "Desktop shortcut migration completed, but Windows Shell icon refresh failed: $($_.Exception.Message)"
    }
} catch {
    if ($NoDesktopShortcut) {
        Write-Warning "ScriptSurgeon was installed, but the legacy desktop shortcut could not be removed: $($_.Exception.Message)"
    } else {
        Write-Warning "ScriptSurgeon was installed, but its desktop shortcut migration could not be completed: $($_.Exception.Message)"
    }
}

Write-Host "ScriptSurgeon $($SourceManifest.version) installed at $InstallDirectory"
Write-Host "Verified $($SourceManifest.fileCount) payload files."
Write-Host "Project data remains in $(Join-Path $InstallDirectory 'Data')"
