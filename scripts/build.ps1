[CmdletBinding()]
param(
    [string]$ModelSource,
    [string]$FfmpegSource,
    [string]$Version,
    [switch]$SkipDependencies,
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$BuildVenv = Join-Path $AppRoot '.packaging-venv'
$BuildPython = Join-Path $BuildVenv 'Scripts\python.exe'
$PyInstaller = Join-Path $BuildVenv 'Scripts\pyinstaller.exe'
$ModelStage = Join-Path $AppRoot 'vendor\models\faster-whisper-base'
$FfmpegStage = Join-Path $AppRoot 'vendor\ffmpeg\ffmpeg.exe'
$IconFile = Join-Path $AppRoot 'assets\scriptcut.ico'
$BuildInfoPath = Join-Path $AppRoot 'build\build-info.json'

if (-not $Version) {
    $Version = (Get-Date).ToUniversalTime().ToString('yyyy.MM.dd.HHmmss')
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
    throw 'Version must be 1-64 characters and contain only letters, numbers, dot, underscore, plus, or hyphen.'
}

function Require-Command {
    param([Parameter(Mandatory)][string]$Name)
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $Command) {
        throw "Required command '$Name' was not found."
    }
    return $Command.Source
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Directory not found: $Source"
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Find-CachedBaseModel {
    $SnapshotRoot = Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--Systran--faster-whisper-base\snapshots'
    if (-not (Test-Path -LiteralPath $SnapshotRoot -PathType Container)) {
        return $null
    }
    return Get-ChildItem -LiteralPath $SnapshotRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'model.bin') } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

Push-Location $AppRoot
try {
    $Commit = (& git rev-parse --short=12 HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $Commit) { $Commit = 'unknown' }
    $BuiltUtc = (Get-Date).ToUniversalTime().ToString('o')
    $env:VITE_SCRIPTSURGEON_BUILD_VERSION = $Version
    $env:VITE_SCRIPTSURGEON_BUILD_COMMIT = $Commit
    $env:SCRIPTCUT_BUILD_VERSION = $Version
    $env:SCRIPTCUT_BUILD_COMMIT = $Commit
    $env:SCRIPTCUT_BUILD_DATE = $BuiltUtc

    if (-not $SkipDependencies) {
        $Uv = Require-Command 'uv.exe'
        if (-not (Test-Path -LiteralPath $BuildPython -PathType Leaf)) {
            Write-Host 'Creating the isolated packaging environment...'
            & $Uv venv $BuildVenv --python 3.11
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the packaging environment.' }
        }

        Write-Host 'Installing pinned build and runtime dependencies...'
        & $Uv pip install --python $BuildPython `
            -r (Join-Path $AppRoot 'backend\requirements.txt') `
            'pywebview==6.2.1' `
            'pyinstaller==6.21.0' `
            'pillow==12.3.0'
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    } else {
        foreach ($RequiredTool in @($BuildPython, $PyInstaller)) {
            if (-not (Test-Path -LiteralPath $RequiredTool -PathType Leaf)) {
                throw "-SkipDependencies requires the existing packaging tool: $RequiredTool"
            }
        }
        Write-Host 'Using the existing isolated packaging environment.'
    }

    & $BuildPython -c "import PIL; assert PIL.__version__ == '12.3.0', PIL.__version__"
    if ($LASTEXITCODE -ne 0) {
        throw 'Icon generation requires Pillow 12.3.0 in the packaging environment. Re-run without -SkipDependencies.'
    }

    if (-not $SkipFrontend) {
        $Npm = Require-Command 'npm.cmd'
        $FrontendLock = Join-Path $AppRoot 'frontend\package-lock.json'
        if (Test-Path -LiteralPath $FrontendLock -PathType Leaf) {
            Write-Host 'Installing locked frontend dependencies...'
            & $Npm ci --prefix (Join-Path $AppRoot 'frontend')
        } else {
            Write-Host 'Installing frontend dependencies and creating a lockfile...'
            & $Npm install --prefix (Join-Path $AppRoot 'frontend')
        }
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }

        & $Npm run build --prefix (Join-Path $AppRoot 'frontend')
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }

    # Package one identity document alongside both runtime layers. It is made
    # under ignored build output so assembling a release never dirties source.
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BuildInfoPath) | Out-Null
    $FrontendAsset = Get-ChildItem -LiteralPath (Join-Path $AppRoot 'frontend\dist\assets') -Filter 'index-*.js' -File |
        Sort-Object Name | Select-Object -First 1
    $FrontendBuildId = if ($FrontendAsset) {
        (Get-FileHash -LiteralPath $FrontendAsset.FullName -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
    } else {
        'unknown'
    }
    [ordered]@{
        version = $Version
        commit = $Commit
        frontendBuildId = $FrontendBuildId
        backendBuildId = $Commit
        builtUtc = $BuiltUtc
    } | ConvertTo-Json | Set-Content -LiteralPath $BuildInfoPath -Encoding UTF8
    $env:SCRIPTCUT_BUILD_INFO_PATH = $BuildInfoPath

    if (-not (Test-Path -LiteralPath (Join-Path $ModelStage 'model.bin') -PathType Leaf)) {
        if (-not $ModelSource) { $ModelSource = $env:SCRIPTCUT_MODEL_SOURCE }
        if (-not $ModelSource) { $ModelSource = Find-CachedBaseModel }
        if ($ModelSource) {
            Write-Host "Staging the local Whisper model from $ModelSource"
            Copy-DirectoryContents -Source $ModelSource -Destination $ModelStage
        } else {
            $ModelDownload = Join-Path $AppRoot ("vendor\models\.faster-whisper-base-download-" + [Guid]::NewGuid().ToString('N'))
            $env:SCRIPTSURGEON_MODEL_DOWNLOAD = $ModelDownload
            try {
                Write-Host 'No cached base model was found; downloading the public Systran faster-whisper-base snapshot...'
                & $BuildPython -c "import os; from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base', local_dir=os.environ['SCRIPTSURGEON_MODEL_DOWNLOAD'])"
                if ($LASTEXITCODE -ne 0) {
                    throw 'The public faster-whisper base model download failed. Re-run online or pass -ModelSource.'
                }
                Copy-DirectoryContents -Source $ModelDownload -Destination $ModelStage
            } finally {
                Remove-Item Env:SCRIPTSURGEON_MODEL_DOWNLOAD -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $ModelDownload) {
                    Remove-Item -LiteralPath $ModelDownload -Recurse -Force
                }
            }
        }
    }

    foreach ($RequiredModelFile in 'config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt') {
        $RequiredPath = Join-Path $ModelStage $RequiredModelFile
        if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
            throw "The staged model is incomplete; missing $RequiredPath"
        }
    }

    if (-not (Test-Path -LiteralPath $FfmpegStage -PathType Leaf)) {
        if (-not $FfmpegSource) { $FfmpegSource = $env:SCRIPTCUT_FFMPEG_SOURCE }
        if (-not $FfmpegSource) {
            $FfmpegCommand = Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue
            if ($FfmpegCommand) { $FfmpegSource = $FfmpegCommand.Source }
        }
        if (-not $FfmpegSource -or -not (Test-Path -LiteralPath $FfmpegSource -PathType Leaf)) {
            throw 'FFmpeg was not found. Pass -FfmpegSource with the path to ffmpeg.exe.'
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $FfmpegStage) | Out-Null
        Copy-Item -LiteralPath $FfmpegSource -Destination $FfmpegStage -Force
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $IconFile) | Out-Null
    & $BuildPython (Join-Path $AppRoot 'scripts\generate_icon.py') $IconFile
    if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }

    Write-Host 'Building the no-console one-folder Windows application...'
    & $PyInstaller --noconfirm --clean (Join-Path $AppRoot 'ScriptSurgeon.spec')
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed.' }

    $BuiltExe = Join-Path $AppRoot 'dist\ScriptSurgeon\ScriptSurgeon.exe'
    if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
        throw "Build completed without the expected executable: $BuiltExe"
    }

    $PayloadRoot = [IO.Path]::GetFullPath((Split-Path -Parent $BuiltExe))
    $ManifestPath = Join-Path $PayloadRoot 'payload-manifest.json'
    $PayloadPrefix = $PayloadRoot.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar

    # The manifest is deliberately not self-referential. Its entries cover every
    # other file in the deployable directory so the installer can reject partial,
    # mixed-version, or unexpectedly augmented payloads before an upgrade starts.
    if (Test-Path -LiteralPath $ManifestPath) {
        Remove-Item -LiteralPath $ManifestPath -Force
    }
    $PayloadFiles = @(
        Get-ChildItem -LiteralPath $PayloadRoot -Recurse -File -Force |
            Sort-Object FullName |
            ForEach-Object {
                $FullName = [IO.Path]::GetFullPath($_.FullName)
                if (-not $FullName.StartsWith($PayloadPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Build output escaped the payload directory: $FullName"
                }
                $RelativePath = $FullName.Substring($PayloadPrefix.Length).Replace('\', '/')
                [ordered]@{
                    path   = $RelativePath
                    size   = [long]$_.Length
                    sha256 = (Get-FileHash -LiteralPath $FullName -Algorithm SHA256).Hash.ToUpperInvariant()
                }
            }
    )
    if ($PayloadFiles.Count -eq 0 -or -not ($PayloadFiles.path -contains 'ScriptSurgeon.exe')) {
        throw 'The build payload is empty or does not contain ScriptSurgeon.exe.'
    }

    $Manifest = [ordered]@{
        schemaVersion = 1
        appName       = 'ScriptSurgeon'
        version       = $Version
        createdUtc    = (Get-Date).ToUniversalTime().ToString('o')
        fileCount     = $PayloadFiles.Count
        files         = $PayloadFiles
    }
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

    # Parse the emitted file once so encoding/serialization failures are caught by
    # the build rather than deferred until installation.
    $WrittenManifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($WrittenManifest.fileCount -ne $PayloadFiles.Count) {
        throw "Payload manifest validation failed: $ManifestPath"
    }
    Write-Host "Build ready: $BuiltExe"
    Write-Host "Payload manifest: $ManifestPath (version $Version, $($PayloadFiles.Count) files)"
} finally {
    Remove-Item Env:VITE_SCRIPTSURGEON_BUILD_VERSION -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_SCRIPTSURGEON_BUILD_COMMIT -ErrorAction SilentlyContinue
    Remove-Item Env:SCRIPTCUT_BUILD_VERSION -ErrorAction SilentlyContinue
    Remove-Item Env:SCRIPTCUT_BUILD_COMMIT -ErrorAction SilentlyContinue
    Remove-Item Env:SCRIPTCUT_BUILD_DATE -ErrorAction SilentlyContinue
    Remove-Item Env:SCRIPTCUT_BUILD_INFO_PATH -ErrorAction SilentlyContinue
    Pop-Location
}
