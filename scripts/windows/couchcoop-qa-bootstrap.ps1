<#
.SYNOPSIS
  Harvest CouchCoop crash evidence from a Windows game host, then (optionally) leave an SSH control
  channel and arm Windows Error Reporting for the next crash.

.DESCRIPTION
  Run this once, at the console, in an ELEVATED PowerShell. It is deliberately ordered
  EVIDENCE FIRST: the harvest completes and the ZIP is written before anything is installed or
  changed, so a failure in the SSH or registry half can never cost you the crash you are chasing.

  Windows has no dmesg/journald ring for a user-mode crash. The equivalents of the Linux
  "segfault ... in <module>" line -- same information, faulting module plus offset -- are Windows
  Error Reporting's Report.wer files and the Application event log, and both are RETROACTIVE: they
  already hold a crash that happened before this script ran. That is what section 1 collects.

  Nothing here is specific to one machine: the host identity, the authorized key and the output
  location are all parameters with no defaults that name a person or a box.

  PowerShell 5.1 / .NET Framework compatible on purpose -- that is what Windows 10 ships, and
  .NET-Core-only overloads are a documented trap on these rigs
  (docs/agents/windows-connection-fingerprints.md section 1).

.PARAMETER PublicKey
  The OpenSSH public key line to authorize (e.g. "ssh-ed25519 AAAA... comment"). Required to set up
  the channel. Mutually exclusive with -PublicKeyFile.

.PARAMETER PublicKeyFile
  A file containing the public key line, if you would rather not paste it on the command line.

.PARAMETER OutputDir
  Where the evidence ZIP is written. Defaults to $env:TEMP.

.PARAMETER GameDir
  The "Slay the Spire 2" install directory. Auto-detected from Steam if omitted.

.PARAMETER CrashWindowHours
  How far back to collect event-log and reliability records. Default 48.

.PARAMETER MaxFileMB
  Any single file larger than this is recorded in the manifest with its path instead of being zipped,
  so one big dump cannot blow up the archive. Default 200.

.PARAMETER DumpType
  Windows Error Reporting LocalDumps type to arm: 1 = mini, 2 = full. Default 2 (full) -- the only
  kind where managed stacks are recoverable. 0 disables arming.

.PARAMETER DumpCount
  How many dumps WER keeps before it stops writing new ones. Default 3.

.PARAMETER SkipHarvest
  Skip the evidence collection and only do the setup half.

.PARAMETER SkipSsh
  Skip the OpenSSH install / key authorization / firewall rule. Harvest only.

.PARAMETER UploadUrl
  Optional. PUT the finished ZIP here (http://<host>:<port>/<name>.zip). Use this when inbound
  connections to this machine are blocked, which is the normal Windows state -- outbound works.

.PARAMETER Revert
  Undo the changes this script makes: remove the LocalDumps key, remove the firewall rule, and remove
  the authorized key line. Does not uninstall OpenSSH and does not touch collected evidence.

.EXAMPLE
  .\couchcoop-qa-bootstrap.ps1 -PublicKey "ssh-ed25519 AAAA... couchcoop-qa"

.EXAMPLE
  .\couchcoop-qa-bootstrap.ps1 -SkipSsh -UploadUrl http://192.0.2.10:8099/evidence.zip

.EXAMPLE
  .\couchcoop-qa-bootstrap.ps1 -Revert -PublicKey "ssh-ed25519 AAAA... couchcoop-qa"
#>

[CmdletBinding()]
param(
    [string] $PublicKey,
    [string] $PublicKeyFile,
    [string] $OutputDir = $env:TEMP,
    [string] $GameDir,
    [int]    $CrashWindowHours = 48,
    [int]    $MaxFileMB = 200,
    [ValidateSet(0, 1, 2)]
    [int]    $DumpType = 2,
    [int]    $DumpCount = 3,
    [switch] $SkipHarvest,
    [switch] $SkipSsh,
    [string] $UploadUrl,
    [switch] $Revert
)

# No Set-StrictMode here on purpose. This script has exactly one chance to run correctly on a machine
# we cannot iterate against, so it must not abort over an unset property on some unexpected install.
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------

$script:Notes = New-Object System.Collections.ArrayList

function Write-Section([string] $Title) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}

function Write-Step([string] $Message) { Write-Host "  - $Message" }
function Write-Ok([string] $Message)   { Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Warn2([string] $Message){ Write-Host "  [warn] $Message" -ForegroundColor Yellow }
function Write-Bad([string] $Message)  { Write-Host "  [FAIL] $Message" -ForegroundColor Red }

function Add-Note([string] $Message) {
    [void] $script:Notes.Add($Message)
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Copy a file the game may still hold OPEN for writing. The host is usually live while this runs, so
# godot.log has a writer; a plain Copy-Item or Compress-Archive fails on it. FileShare ReadWrite+Delete
# is what makes the read succeed against another process's write handle.
function Copy-PossiblyLockedFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Destination
    )

    $destDir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $destDir)) {
        [void] (New-Item -ItemType Directory -Force -Path $destDir)
    }

    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $in = $null
    $out = $null
    try {
        $in = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        $out = New-Object System.IO.FileStream($Destination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $in.CopyTo($out)
        return $true
    } catch {
        Add-Note "could not read '$Path': $($_.Exception.Message)"
        return $false
    } finally {
        if ($out) { $out.Dispose() }
        if ($in)  { $in.Dispose() }
    }
}

# Collect files into the staging tree, preserving enough of the path to stay identifiable, and
# refusing anything too large to zip (recorded instead, so it can be fetched separately).
function Add-Evidence {
    param(
        [Parameter(Mandatory)] [string] $SourcePath,
        [Parameter(Mandatory)] [string] $StagingRelativePath
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) { return $false }

    $info = Get-Item -LiteralPath $SourcePath -Force
    if ($info.Length -gt ($MaxFileMB * 1MB)) {
        $mb = [math]::Round($info.Length / 1MB, 1)
        Add-Note "TOO LARGE to zip ($mb MB), fetch separately: $SourcePath"
        Write-Warn2 "skipped ($mb MB, over -MaxFileMB): $SourcePath"
        return $false
    }

    $dest = Join-Path $script:Staging $StagingRelativePath
    if (Copy-PossiblyLockedFile -Path $SourcePath -Destination $dest) {
        $kb = [math]::Round($info.Length / 1KB, 1)
        Write-Step "collected ($kb KB): $SourcePath"
        return $true
    }
    return $false
}

function Save-Text {
    param(
        [Parameter(Mandatory)] [string] $StagingRelativePath,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Content
    )
    $dest = Join-Path $script:Staging $StagingRelativePath
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) {
        [void] (New-Item -ItemType Directory -Force -Path $destDir)
    }
    Set-Content -LiteralPath $dest -Value $Content -Encoding UTF8
}

# ---------------------------------------------------------------------------------------------------
# Game / install discovery
# ---------------------------------------------------------------------------------------------------

$script:Sts2AppId = '2868840'
$script:Sts2FolderName = 'Slay the Spire 2'
$script:Sts2ExeName = 'SlayTheSpire2.exe'

function Get-SteamLibraryRoots {
    $roots = New-Object System.Collections.ArrayList

    $installPath = $null
    foreach ($key in @('HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam')) {
        try {
            $value = Get-ItemProperty -Path $key -ErrorAction Stop
            foreach ($name in @('SteamPath', 'InstallPath')) {
                if (($value.PSObject.Properties.Name -contains $name) -and $value.$name) {
                    $installPath = $value.$name
                    break
                }
            }
            if ($installPath) { break }
        } catch { }
    }

    if ($installPath) { [void] $roots.Add(($installPath -replace '/', '\')) }

    # Other library folders. The VDF is simple enough that one regex over "path" beats a parser here.
    if ($installPath) {
        $vdf = Join-Path $installPath 'steamapps\libraryfolders.vdf'
        if (Test-Path -LiteralPath $vdf) {
            try {
                foreach ($line in (Get-Content -LiteralPath $vdf -ErrorAction Stop)) {
                    $m = [regex]::Match($line, '"path"\s+"(?<p>[^"]+)"')
                    if ($m.Success) { [void] $roots.Add(($m.Groups['p'].Value -replace '\\\\', '\')) }
                }
            } catch { }
        }
    }

    foreach ($guess in @(
            "${env:ProgramFiles(x86)}\Steam",
            "$env:ProgramFiles\Steam",
            'C:\Steam')) {
        if ($guess -and (Test-Path -LiteralPath $guess)) { [void] $roots.Add($guess) }
    }

    return ($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Resolve-GameDir {
    if ($GameDir) {
        if (Test-Path -LiteralPath $GameDir) { return $GameDir }
        Write-Warn2 "-GameDir '$GameDir' does not exist; falling back to auto-detection"
    }

    foreach ($root in (Get-SteamLibraryRoots)) {
        $candidate = Join-Path $root "steamapps\common\$script:Sts2FolderName"
        if (Test-Path -LiteralPath (Join-Path $candidate $script:Sts2ExeName)) { return $candidate }
    }
    return $null
}

function Get-GameExePath {
    param([string] $Dir)
    if ($Dir) {
        $exe = Join-Path $Dir $script:Sts2ExeName
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
    return $null
}

# ---------------------------------------------------------------------------------------------------
# Revert
# ---------------------------------------------------------------------------------------------------

function Invoke-Revert {
    Write-Section 'REVERT'

    $localDumpsKey = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$script:Sts2ExeName"
    if (Test-Path -LiteralPath $localDumpsKey) {
        try {
            Remove-Item -LiteralPath $localDumpsKey -Recurse -Force
            Write-Ok "removed LocalDumps key for $script:Sts2ExeName"
        } catch { Write-Bad "could not remove LocalDumps key: $($_.Exception.Message)" }
    } else {
        Write-Step "no LocalDumps key for $script:Sts2ExeName (nothing to remove)"
    }

    try {
        $rule = Get-NetFirewallRule -Name 'CouchCoopQA-SSH' -ErrorAction SilentlyContinue
        if ($rule) {
            Remove-NetFirewallRule -Name 'CouchCoopQA-SSH'
            Write-Ok 'removed firewall rule CouchCoopQA-SSH'
        } else {
            Write-Step 'no CouchCoopQA-SSH firewall rule (nothing to remove)'
        }
    } catch { Write-Bad "firewall revert failed: $($_.Exception.Message)" }

    $keyLine = Get-RequestedPublicKey
    if ($keyLine) {
        $authFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
        if (Test-Path -LiteralPath $authFile) {
            $kept = @(Get-Content -LiteralPath $authFile | Where-Object { $_.Trim() -ne $keyLine.Trim() })
            Set-Content -LiteralPath $authFile -Value $kept -Encoding ASCII
            Write-Ok "removed the key from $authFile"
        }
    } else {
        Write-Step 'no -PublicKey given, so no authorized key line was removed'
    }

    Write-Host ''
    Write-Host '  OpenSSH itself was NOT uninstalled, and no collected evidence was deleted.' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------------------------------
# Harvest
# ---------------------------------------------------------------------------------------------------

function Invoke-Harvest {
    param([string] $ResolvedGameDir)

    Write-Section '1. EVIDENCE HARVEST (runs before any change)'

    $userDir = Join-Path $env:APPDATA 'SlayTheSpire2'
    $couch = Join-Path $userDir 'couch-coop'
    $collected = 0

    # --- Host log and every rotated sibling. Godot keeps ~5, so the crash session is in here only
    # --- until further launches push it out. This is the time-sensitive part of the whole script.
    Write-Host ''
    Write-Host '  Host logs' -ForegroundColor White
    $hostLogs = Join-Path $userDir 'logs'
    if (Test-Path -LiteralPath $hostLogs) {
        foreach ($f in (Get-ChildItem -LiteralPath $hostLogs -File -ErrorAction SilentlyContinue)) {
            if (Add-Evidence -SourcePath $f.FullName -StagingRelativePath "host-logs\$($f.Name)") { $collected++ }
        }
    } else {
        Write-Warn2 "no host log dir at $hostLogs"
        Add-Note "host log dir absent: $hostLogs"
    }

    # --- Per-slot client ("seat") logs. This is the PRIMARY evidence when a browser player's game
    # --- died. Note SlayTheSpire2 appears twice in the path -- that is not a typo, it is
    # --- HeadlessUserDirSeeder.SlotBase + SlotUserDir.
    Write-Host ''
    Write-Host '  Per-player (seat) logs' -ForegroundColor White
    $slotsRoot = Join-Path $couch 'headless-slots'
    if (Test-Path -LiteralPath $slotsRoot) {
        foreach ($slotDir in (Get-ChildItem -LiteralPath $slotsRoot -Directory -ErrorAction SilentlyContinue)) {
            $slotLogs = Join-Path $slotDir.FullName 'SlayTheSpire2\logs'
            if (Test-Path -LiteralPath $slotLogs) {
                foreach ($f in (Get-ChildItem -LiteralPath $slotLogs -File -ErrorAction SilentlyContinue)) {
                    if (Add-Evidence -SourcePath $f.FullName -StagingRelativePath "seat-logs\$($slotDir.Name)\$($f.Name)") { $collected++ }
                }
            } else {
                Add-Note "slot dir with no logs subdir: $($slotDir.FullName)"
            }
        }
    } else {
        Write-Warn2 "no headless-slots dir at $slotsRoot"
        Add-Note "headless-slots absent: $slotsRoot"
    }

    # --- The no-isolation fallback path (HeadlessClientManager.SeatLogPath). On this path log reuse
    # --- can TRUNCATE rather than rotate, so its absence or emptiness is itself a finding.
    $seatLogsFallback = Join-Path $couch 'seat-logs'
    if (Test-Path -LiteralPath $seatLogsFallback) {
        foreach ($f in (Get-ChildItem -LiteralPath $seatLogsFallback -File -ErrorAction SilentlyContinue)) {
            if (Add-Evidence -SourcePath $f.FullName -StagingRelativePath "seat-logs-fallback\$($f.Name)") { $collected++ }
        }
    }

    # --- Windows Error Reporting. The retroactive record of the faulting module and offset.
    Write-Host ''
    Write-Host '  Windows Error Reporting' -ForegroundColor White
    $werRoot = Join-Path $env:ProgramData 'Microsoft\Windows\WER'
    $werFound = 0
    foreach ($bucketName in @('ReportArchive', 'ReportQueue')) {
        $bucket = Join-Path $werRoot $bucketName
        if (-not (Test-Path -LiteralPath $bucket)) { continue }
        try {
            $dirs = Get-ChildItem -LiteralPath $bucket -Directory -ErrorAction Stop
        } catch {
            Write-Warn2 "cannot list $bucket ($($_.Exception.Message)) -- are you elevated?"
            Add-Note "WER bucket unreadable: $bucket"
            continue
        }
        foreach ($d in $dirs) {
            $matched = $d.Name -like "*SlayTheSpire*"
            if (-not $matched) {
                $wer = Join-Path $d.FullName 'Report.wer'
                if (Test-Path -LiteralPath $wer) {
                    try {
                        if (Select-String -LiteralPath $wer -Pattern 'SlayTheSpire' -SimpleMatch -Quiet -ErrorAction Stop) { $matched = $true }
                    } catch { }
                }
            }
            if (-not $matched) { continue }
            foreach ($f in (Get-ChildItem -LiteralPath $d.FullName -File -ErrorAction SilentlyContinue)) {
                if (Add-Evidence -SourcePath $f.FullName -StagingRelativePath "wer\$bucketName\$($d.Name)\$($f.Name)") {
                    $collected++
                    $werFound++
                }
            }
        }
    }
    if ($werFound -eq 0) {
        Write-Warn2 'no WER report names SlayTheSpire -- see the crashpad note in the manifest'
        Add-Note 'WER has NO SlayTheSpire report. Either the crash was claimed by the game''s own crashpad handler (check the crashpad section), or WER is disabled, or the process was killed rather than faulting.'
    }

    # --- Application event log: 1000 = Application Error (native, faulting module + offset),
    # --- 1026 = .NET Runtime (managed exception TYPE and STACK), 1001 = WER bucket summary.
    Write-Host ''
    Write-Host "  Application event log (last $CrashWindowHours h, IDs 1000/1001/1026)" -ForegroundColor White
    $since = (Get-Date).AddHours(-1 * $CrashWindowHours)
    $events = @()
    $queryFailed = $null
    try {
        $events = @(Get-WinEvent -FilterHashtable @{
                LogName   = 'Application'
                Id        = 1000, 1001, 1026
                StartTime = $since
            } -ErrorAction Stop)
    } catch {
        # Get-WinEvent THROWS on a zero-match filter instead of returning an empty set. Treating that
        # as a failure reports "the query broke" when the truthful answer is "this box recorded no
        # crash in the window" -- an actively misleading distinction on the machine you are triaging.
        if ($_.Exception.Message -match 'No events were found') {
            $events = @()
        } else {
            $queryFailed = $_.Exception.Message
        }
    }

    if ($queryFailed) {
        Write-Warn2 "event log query failed: $queryFailed"
        Add-Note "event log query FAILED (not the same as 'no events'): $queryFailed"
    } else {
        if ($events.Count -gt 0) {
            $text = $events | ForEach-Object {
                @"
---------------------------------------------------------------------------
TimeCreated : $($_.TimeCreated.ToString('o'))
Id          : $($_.Id)
Provider    : $($_.ProviderName)
Level       : $($_.LevelDisplayName)
Message     :
$($_.Message)
"@
            }
            Save-Text -StagingRelativePath 'eventlog\application-1000-1001-1026.txt' -Content ($text -join "`r`n")
            Write-Step "collected $($events.Count) event(s)"
            $collected++

            $sts2 = @($events | Where-Object { $_.Message -match 'SlayTheSpire' })
            if ($sts2.Count -gt 0) {
                Save-Text -StagingRelativePath 'eventlog\application-slaythespire-only.txt' `
                    -Content (($sts2 | ForEach-Object { "$($_.TimeCreated.ToString('o'))  id=$($_.Id)  $($_.ProviderName)`r`n$($_.Message)`r`n" }) -join "`r`n")
                Write-Ok "$($sts2.Count) of them name SlayTheSpire"
            } else {
                Write-Warn2 'none of them name SlayTheSpire'
                Add-Note 'No 1000/1001/1026 event in the window names SlayTheSpire.'
            }
        } else {
            Write-Warn2 "no 1000/1001/1026 events in the last $CrashWindowHours h (the query ran; the log is simply empty for them)"
            Save-Text -StagingRelativePath 'eventlog\application-1000-1001-1026.txt' `
                -Content "No events with ID 1000/1001/1026 in the Application log since $($since.ToString('o'))."
            Add-Note "No 1000/1001/1026 events within $CrashWindowHours h. Widen with -CrashWindowHours."
        }
    }

    # Full .evtx too -- the text rendering above loses structured fields, and an evtx can be reopened.
    try {
        $evtx = Join-Path $script:Staging 'eventlog\Application.evtx'
        [void] (New-Item -ItemType Directory -Force -Path (Split-Path -Parent $evtx))
        $q = "*[System[(EventID=1000 or EventID=1001 or EventID=1026)]]"
        & wevtutil epl Application "$evtx" "/q:$q" '/ow:true' 2>&1 | Out-Null
        if (Test-Path -LiteralPath $evtx) { Write-Ok 'exported Application.evtx' }
    } catch {
        Add-Note "wevtutil export failed: $($_.Exception.Message)"
    }

    # --- Reliability records: a cheap index of recent app crashes. Needs the RACAgent task to have run.
    try {
        $rel = @(Get-CimInstance -ClassName Win32_ReliabilityRecords -ErrorAction Stop |
                Where-Object { $_.TimeGenerated -ge $since })
        if ($rel.Count -gt 0) {
            Save-Text -StagingRelativePath 'eventlog\reliability-records.txt' `
                -Content (($rel | Format-List * | Out-String))
            Write-Step "collected $($rel.Count) reliability record(s)"
        } else {
            Add-Note 'Win32_ReliabilityRecords returned nothing in the window (RACAgent may be disabled).'
        }
    } catch {
        Add-Note "Win32_ReliabilityRecords unavailable: $($_.Exception.Message)"
    }

    # --- Crashpad / Sentry. If the game's own native crash handler claimed the fault, WER will be
    # --- empty and the dump is HERE instead. Collect both; let the evidence say which one fired.
    Write-Host ''
    Write-Host '  Crashpad / Sentry local dumps' -ForegroundColor White
    $dumpRoots = @($userDir)
    if ($ResolvedGameDir) { $dumpRoots += $ResolvedGameDir }
    $dumpRoots += (Join-Path $env:LOCALAPPDATA 'CrashDumps')

    $dumpHits = 0
    foreach ($root in ($dumpRoots | Select-Object -Unique)) {
        if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
        try {
            # -Filter, not -Include: -Include silently matches nothing against a directory LiteralPath.
            $dmps = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.dmp' -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -ge $since })
        } catch { $dmps = @() }
        foreach ($d in $dmps) {
            $dumpHits++
            if (Add-Evidence -SourcePath $d.FullName -StagingRelativePath "dumps\$($d.Name)") { $collected++ }
        }
        # The database directories themselves are worth an inventory even when the dumps are gone.
        try {
            $dbs = @(Get-ChildItem -LiteralPath $root -Recurse -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match 'crashpad|sentry' })
            if ($dbs.Count -gt 0) {
                Save-Text -StagingRelativePath "dumps\crashpad-db-inventory-$([IO.Path]::GetFileName($root)).txt" `
                    -Content (($dbs | ForEach-Object {
                            "$($_.FullName)`r`n" + (
                                (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
                                    ForEach-Object { "    $($_.LastWriteTime.ToString('o'))  $($_.Length)  $($_.FullName)" }) -join "`r`n")
                        }) -join "`r`n`r`n")
                Write-Step "inventoried $($dbs.Count) crashpad/sentry dir(s) under $root"
            }
        } catch { }
    }
    if ($dumpHits -eq 0) {
        Write-Step "no .dmp newer than $CrashWindowHours h under the searched roots"
        if ($DumpType -eq 0) {
            Add-Note 'No recent .dmp found, and LocalDumps was NOT armed (-DumpType 0), so the next crash will not leave one either.'
        } else {
            Add-Note 'No recent .dmp found. This run arms LocalDumps, so the NEXT crash will leave one.'
        }
    }

    # --- Identity, so the evidence is attributable to a build.
    Write-Host ''
    Write-Host '  Identity' -ForegroundColor White
    $identity = New-Object System.Collections.ArrayList
    [void] $identity.Add("collectedUtc        : $((Get-Date).ToUniversalTime().ToString('o'))")
    [void] $identity.Add("windows             : $([Environment]::OSVersion.VersionString)")
    try {
        $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        [void] $identity.Add("windowsProduct      : $($cv.ProductName) $($cv.DisplayVersion) build $($cv.CurrentBuild).$($cv.UBR)")
    } catch { }
    [void] $identity.Add("powershell          : $($PSVersionTable.PSVersion)")
    [void] $identity.Add("elevated            : $(Test-Elevated)")
    [void] $identity.Add("userDir             : $userDir")
    [void] $identity.Add("gameDir             : $(if ($ResolvedGameDir) { $ResolvedGameDir } else { '<not found>' })")

    if ($ResolvedGameDir) {
        $crashpadExe = Join-Path $ResolvedGameDir 'crashpad_handler.exe'
        # Surfaced in the VERDICT too: this decides WHO owns a native crash on this box. If crashpad is
        # present and active it can claim the fault and WER then has nothing -- so an empty WER section
        # means something different depending on this one line.
        $script:CrashpadPresent = if (Test-Path -LiteralPath $crashpadExe) { 'PRESENT' } else { 'absent' }
        [void] $identity.Add("crashpad_handler.exe: $script:CrashpadPresent")

        # Game branch and buildid. Grep the manifest CASE-INSENSITIVELY: the key is spelled "BetaKey",
        # and a case-sensitive grep for "betakey" finding nothing reads as "default branch", which is
        # exactly the wrong conclusion (windows-connection-fingerprints.md section 4).
        $steamapps = Split-Path -Parent (Split-Path -Parent $ResolvedGameDir)
        $acf = Join-Path $steamapps "appmanifest_$script:Sts2AppId.acf"
        if (Test-Path -LiteralPath $acf) {
            $acfText = Get-Content -LiteralPath $acf -Raw
            foreach ($k in @('buildid', 'BetaKey', 'StateFlags')) {
                $m = [regex]::Match($acfText, "`"$k`"\s+`"(?<v>[^`"]*)`"", 'IgnoreCase')
                $v = if ($m.Success) { $m.Groups['v'].Value } else { '<absent>' }
                [void] $identity.Add(("steam_{0,-13}: {1}" -f $k, $v))
                if ($k -eq 'buildid') { $script:SteamBuildId = $v }
                if ($k -eq 'BetaKey') { $script:SteamBranch = $v }
            }
            [void] (Add-Evidence -SourcePath $acf -StagingRelativePath "identity\appmanifest_$script:Sts2AppId.acf")
        } else {
            Add-Note "no appmanifest at $acf"
        }

        # Installed mods, so a third-party conflict is visible. (BaseLib and RitsuLib have both caused
        # CouchCoop-shaped symptoms before.)
        $modsDir = Join-Path $ResolvedGameDir 'mods'
        if (Test-Path -LiteralPath $modsDir) {
            $modLines = Get-ChildItem -LiteralPath $modsDir -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { "    $($_.Name)" }
            [void] $identity.Add("mods                :`r`n$($modLines -join "`r`n")")
            foreach ($manifest in (Get-ChildItem -LiteralPath $modsDir -Recurse -File -Filter '*.json' -Depth 1 -ErrorAction SilentlyContinue)) {
                [void] (Add-Evidence -SourcePath $manifest.FullName -StagingRelativePath "identity\mods\$($manifest.Directory.Name)-$($manifest.Name)")
            }
        }
    }

    # The mod's own startup lines carry build, lane and cache root. Pull them straight out of the log.
    $hostGodotLog = Join-Path $hostLogs 'godot.log'
    if (Test-Path -LiteralPath $hostGodotLog) {
        try {
            $staged = Join-Path $script:Staging 'host-logs\godot.log'
            $readFrom = if (Test-Path -LiteralPath $staged) { $staged } else { $hostGodotLog }
            $couchLines = @(Select-String -LiteralPath $readFrom -Pattern '\[couchcoop\]' -ErrorAction SilentlyContinue |
                    Select-Object -First 60 | ForEach-Object { $_.Line })
            if ($couchLines.Count -gt 0) {
                Save-Text -StagingRelativePath 'identity\couchcoop-startup-lines.txt' -Content ($couchLines -join "`r`n")
                Write-Ok "extracted $($couchLines.Count) [couchcoop] line(s)"
            } else {
                Add-Note 'No [couchcoop] lines in the host log -- did the mod load at all?'
            }
        } catch { }
    }

    Save-Text -StagingRelativePath 'identity\identity.txt' -Content ($identity -join "`r`n")

    return $collected
}

# The cheapest possible answer to "was it a segfault", and it needs nothing but the host log:
# HeadlessClientManager logs `headless exited early slot=N exitCode=X`. On Windows an access
# violation surfaces as exit code 0xC0000005 = -1073741819 (3221225477 unsigned).
function Show-ExitCodeVerdict {
    Write-Section '2. SEAT EXIT CODES FROM THE HOST LOG (the cheap segfault test)'

    $candidates = @()
    $staged = Join-Path $script:Staging 'host-logs'
    if (Test-Path -LiteralPath $staged) {
        $candidates = @(Get-ChildItem -LiteralPath $staged -File | Sort-Object LastWriteTime -Descending)
    }
    if ($candidates.Count -eq 0) {
        Write-Warn2 'no host log was collected, so no exit code to read'
        return
    }

    $any = $false
    foreach ($f in $candidates) {
        $hits = @(Select-String -LiteralPath $f.FullName -Pattern 'exitCode=|exited early|headless (exit|died|crash)' -ErrorAction SilentlyContinue)
        foreach ($h in $hits) {
            $any = $true
            Write-Host "  $($f.Name):$($h.LineNumber)  $($h.Line.Trim())"
            foreach ($m in [regex]::Matches($h.Line, 'exitCode=(?<c>-?\d+)')) {
                $code = [int64] $m.Groups['c'].Value
                $unsigned = if ($code -lt 0) { $code + 4294967296 } else { $code }
                $hex = ('0x{0:X8}' -f $unsigned)
                $meaning = switch ($unsigned) {
                    3221225477 { 'ACCESS VIOLATION (0xC0000005) -- a real segfault' }
                    3221225725 { 'STACK OVERFLOW (0xC00000FD)' }
                    3221225786 { 'CTRL+C / terminated (0xC000013A)' }
                    3762504530 { 'UNHANDLED MANAGED EXCEPTION (0xE0434352) -- look for event ID 1026' }
                    0          { 'clean exit' }
                    default    { 'see the event log for this code' }
                }
                Write-Host "      -> exit $code = $hex : $meaning" -ForegroundColor Yellow
            }
        }
    }
    if (-not $any) {
        Write-Warn2 'no exitCode= / "exited early" lines found in any collected host log'
        Add-Note 'Host log has no seat exit-code line. The seat may have died after the launch window, or the relevant session already rotated out.'
    }
}

# ---------------------------------------------------------------------------------------------------
# Setup half
# ---------------------------------------------------------------------------------------------------

function Get-RequestedPublicKey {
    if ($PublicKeyFile) {
        if (-not (Test-Path -LiteralPath $PublicKeyFile)) { throw "-PublicKeyFile '$PublicKeyFile' not found" }
        $line = (Get-Content -LiteralPath $PublicKeyFile -ErrorAction Stop | Where-Object { $_.Trim() } | Select-Object -First 1)
        return $line.Trim()
    }
    if ($PublicKey) { return $PublicKey.Trim() }
    return $null
}

function Install-SshServer {
    Write-Section '3. OPENSSH SERVER'

    $already = $false
    try {
        $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop
        if ($cap.State -eq 'Installed') {
            Write-Ok 'OpenSSH.Server capability already installed'
            $already = $true
        }
    } catch {
        Write-Warn2 "could not query the capability store: $($_.Exception.Message)"
    }

    if (-not $already) {
        try {
            Write-Step 'installing OpenSSH.Server capability (this can take a minute)'
            [void] (Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop)
            Write-Ok 'installed via Add-WindowsCapability'
        } catch {
            Write-Bad "Add-WindowsCapability failed: $($_.Exception.Message)"
            Write-Host ''
            Write-Host '  FALLBACK -- the capability store can refuse on a metered or WSUS-managed box.' -ForegroundColor Yellow
            Write-Host '  Install Win32-OpenSSH by hand, then re-run this script:' -ForegroundColor Yellow
            Write-Host '    1. Download OpenSSH-Win64.zip from https://github.com/PowerShell/Win32-OpenSSH/releases' -ForegroundColor Yellow
            Write-Host '    2. Expand-Archive it to C:\Program Files\OpenSSH' -ForegroundColor Yellow
            Write-Host '    3. powershell -ExecutionPolicy Bypass -File "C:\Program Files\OpenSSH\install-sshd.ps1"' -ForegroundColor Yellow
            Add-Note 'OpenSSH install FAILED via capability store; manual Win32-OpenSSH fallback required.'
            return $false
        }
    }

    try {
        Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
        Write-Ok 'sshd startup type = Automatic (survives reboot)'
    } catch { Write-Bad "could not set sshd to Automatic: $($_.Exception.Message)" }

    try {
        Start-Service -Name sshd -ErrorAction Stop
        Write-Ok 'sshd started'
    } catch {
        $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { Write-Ok 'sshd already running' }
        else { Write-Bad "could not start sshd: $($_.Exception.Message)"; return $false }
    }

    return $true
}

function Grant-AuthorizedKey {
    param([Parameter(Mandatory)] [string] $KeyLine)

    Write-Section '4. AUTHORIZE THE KEY'

    # For an ADMIN account sshd ignores the per-user ~\.ssh\authorized_keys and reads only this file.
    # That is the single most common reason key auth "silently does not work" on Windows.
    $sshDir = Join-Path $env:ProgramData 'ssh'
    if (-not (Test-Path -LiteralPath $sshDir)) { [void] (New-Item -ItemType Directory -Force -Path $sshDir) }
    $authFile = Join-Path $sshDir 'administrators_authorized_keys'

    $existing = @()
    if (Test-Path -LiteralPath $authFile) {
        $existing = @(Get-Content -LiteralPath $authFile -ErrorAction SilentlyContinue)
    }

    if ($existing | Where-Object { $_.Trim() -eq $KeyLine }) {
        Write-Ok 'key already authorized (idempotent, nothing appended)'
    } else {
        Set-Content -LiteralPath $authFile -Value (@($existing | Where-Object { $_.Trim() }) + $KeyLine) -Encoding ASCII
        Write-Ok "appended the key to $authFile"
    }

    # The ACL matters as much as the file: sshd REFUSES the file if it is writable by anyone else.
    & icacls "$authFile" /inheritance:r /grant 'Administrators:F' 'SYSTEM:F' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'ACL set: inheritance removed, Administrators + SYSTEM full control only'
    } else {
        Write-Bad "icacls returned $LASTEXITCODE -- sshd will refuse the file if its ACL is too open"
        Add-Note "icacls on $authFile returned $LASTEXITCODE"
    }
}

function Add-SshFirewallRule {
    Write-Section '5. FIREWALL'

    $name = 'CouchCoopQA-SSH'
    try {
        $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Ok "rule $name already exists"
        } else {
            # LocalSubnet, not Any: this is a real laptop on a real LAN, not a NAT-only guest.
            [void] (New-NetFirewallRule -Name $name -DisplayName 'CouchCoop QA - SSH (local subnet)' `
                    -Description 'Inbound SSH for CouchCoop QA. Scoped to the local subnet. Safe to delete.' `
                    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
                    -RemoteAddress LocalSubnet -Profile Any -Enabled True -ErrorAction Stop)
            Write-Ok "created $name : TCP/22 inbound, RemoteAddress=LocalSubnet, all profiles"
        }
    } catch {
        Write-Bad "firewall rule failed: $($_.Exception.Message)"
        Add-Note "firewall rule failed: $($_.Exception.Message)"
    }
}

function Set-LocalDumps {
    Write-Section '6. ARM WINDOWS ERROR REPORTING FOR THE NEXT CRASH'

    if ($DumpType -eq 0) {
        Write-Step '-DumpType 0 -- not arming LocalDumps'
        return
    }

    $dumpFolder = Join-Path $env:LOCALAPPDATA 'CrashDumps'
    if (-not (Test-Path -LiteralPath $dumpFolder)) { [void] (New-Item -ItemType Directory -Force -Path $dumpFolder) }

    $base = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
    $key = Join-Path $base $script:Sts2ExeName
    try {
        if (-not (Test-Path -LiteralPath $base)) { [void] (New-Item -Path $base -Force) }
        if (-not (Test-Path -LiteralPath $key)) { [void] (New-Item -Path $key -Force) }
        New-ItemProperty -Path $key -Name 'DumpFolder' -Value $dumpFolder -PropertyType ExpandString -Force | Out-Null
        New-ItemProperty -Path $key -Name 'DumpType'   -Value $DumpType   -PropertyType DWord        -Force | Out-Null
        New-ItemProperty -Path $key -Name 'DumpCount'  -Value $DumpCount  -PropertyType DWord        -Force | Out-Null

        $kind = if ($DumpType -eq 2) { 'FULL (managed stacks recoverable)' } else { 'mini (native only)' }
        Write-Ok "armed for $script:Sts2ExeName : $kind, keep $DumpCount"
        Write-Host "         dumps will appear in: $dumpFolder" -ForegroundColor DarkGray
        if ($DumpType -eq 2) {
            Write-Host "         a full dump of this game is roughly 1-3 GB; $DumpCount are kept" -ForegroundColor DarkGray
        }
        Write-Host "         undo with: .\couchcoop-qa-bootstrap.ps1 -Revert" -ForegroundColor DarkGray

        # Scoped deliberately: the key names one executable, so nothing else on the box starts
        # writing dumps. Note the seat processes are the SAME exe, so they are covered too.
    } catch {
        Write-Bad "could not write the LocalDumps key: $($_.Exception.Message)"
        Add-Note "LocalDumps arming failed: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------

Write-Host ''
Write-Host '  CouchCoop Windows QA bootstrap' -ForegroundColor White
Write-Host '  evidence first, then the control channel' -ForegroundColor DarkGray

if (-not (Test-Elevated)) {
    Write-Host ''
    Write-Warn2 'NOT running elevated. WER reports are unreadable and the setup half will fail.'
    Write-Warn2 'Re-run from an Administrator PowerShell.'
    Add-Note 'Script ran WITHOUT elevation.'
}

if ($Revert) {
    Invoke-Revert
    Write-Host ''
    Write-Host '  Done (revert).' -ForegroundColor Green
    return
}

$resolvedGameDir = Resolve-GameDir
if (-not $resolvedGameDir) {
    Write-Warn2 'could not locate the Slay the Spire 2 install; pass -GameDir to include game-side evidence'
    Add-Note 'Game dir not found; crashpad and Steam-branch evidence were skipped.'
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$zipName = "couchcoop-evidence-$env:COMPUTERNAME-$stamp.zip"
$script:Staging = Join-Path $env:TEMP "couchcoop-evidence-$stamp"
$zipPath = Join-Path $OutputDir $zipName
$collectedCount = 0

if (-not $SkipHarvest) {
    [void] (New-Item -ItemType Directory -Force -Path $script:Staging)
    $collectedCount = Invoke-Harvest -ResolvedGameDir $resolvedGameDir
    Show-ExitCodeVerdict

    if ($script:Notes.Count -gt 0) {
        Save-Text -StagingRelativePath 'MANIFEST-NOTES.txt' -Content (($script:Notes | ForEach-Object { "- $_" }) -join "`r`n")
    }

    Write-Section 'PACKAGING'
    try {
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        Compress-Archive -Path (Join-Path $script:Staging '*') -DestinationPath $zipPath -CompressionLevel Optimal -ErrorAction Stop
        $zipMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
        Write-Ok "wrote $zipPath ($zipMb MB, $collectedCount file(s) collected)"
        Remove-Item -LiteralPath $script:Staging -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Bad "could not create the ZIP: $($_.Exception.Message)"
        Write-Warn2 "the staging tree is intact at: $script:Staging"
        $zipPath = $null
    }

    if ($zipPath -and $UploadUrl) {
        Write-Step "uploading to $UploadUrl"
        try {
            # -UseBasicParsing for PS 5.1; PUT so a one-shot receiver can just write the body out.
            Invoke-WebRequest -Uri $UploadUrl -Method Put -InFile $zipPath -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop | Out-Null
            Write-Ok 'uploaded'
        } catch {
            Write-Bad "upload failed: $($_.Exception.Message)"
            Write-Warn2 'copy the ZIP off by hand, or fetch it over SSH once the channel is up'
        }
    }
}

if (-not $SkipSsh) {
    $keyLine = Get-RequestedPublicKey
    if (-not $keyLine) {
        Write-Section '3-5. OPENSSH (SKIPPED)'
        Write-Warn2 'no -PublicKey / -PublicKeyFile given, so the control channel was not set up'
        Add-Note 'SSH setup skipped: no public key supplied.'
    } else {
        if (Install-SshServer) {
            Grant-AuthorizedKey -KeyLine $keyLine
            Add-SshFirewallRule
        }
    }
}

Set-LocalDumps

# ---------------------------------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------------------------------

Write-Section 'VERDICT'

Write-Host "  hostname        : $env:COMPUTERNAME"
Write-Host "  windows user    : $env:USERNAME"
try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -ne '127.0.0.1' } |
        ForEach-Object { Write-Host "  ip              : $($_.IPAddress)/$($_.PrefixLength)  if=$($_.InterfaceAlias)" }
    Get-NetAdapter -ErrorAction Stop | Where-Object Status -eq 'Up' |
        ForEach-Object { Write-Host "  mac             : $($_.MacAddress)  if=$($_.Name)" }
} catch {
    Write-Warn2 "could not enumerate adapters: $($_.Exception.Message)"
}

$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if ($svc) {
    # Computed first: a nested double-quoted -Filter inside $() inside a double-quoted string is a
    # PowerShell 5.1 parsing hazard, and this line must not be the thing that breaks the run.
    $startMode = '?'
    try { $startMode = (Get-CimInstance -ClassName Win32_Service -Filter 'Name="sshd"').StartMode } catch { }
    Write-Host "  sshd            : $($svc.Status), startup=$startMode"
} else {
    Write-Host '  sshd            : NOT INSTALLED'
}

try {
    $listen = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
    Write-Host "  listening on 22 : $(if ($listen.Count -gt 0) { 'yes' } else { 'NO' })"
} catch { }

if ($script:CrashpadPresent) {
    Write-Host "  crashpad        : $script:CrashpadPresent  (if PRESENT, an empty WER section may mean crashpad claimed the crash)"
}
if ($script:SteamBuildId -or $script:SteamBranch) {
    $branch = if ($script:SteamBranch) { $script:SteamBranch } else { '<default branch>' }
    Write-Host "  game            : buildid=$script:SteamBuildId branch=$branch"
}

$ldKey = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$script:Sts2ExeName"
if (Test-Path -LiteralPath $ldKey) {
    $ld = Get-ItemProperty -LiteralPath $ldKey
    Write-Host "  LocalDumps      : armed, DumpType=$($ld.DumpType) DumpCount=$($ld.DumpCount) -> $($ld.DumpFolder)"
} else {
    Write-Host '  LocalDumps      : not armed'
}

if ($zipPath -and (Test-Path -LiteralPath $zipPath)) {
    Write-Host ''
    Write-Host "  EVIDENCE ZIP    : $zipPath" -ForegroundColor Green
} elseif (-not $SkipHarvest) {
    Write-Host ''
    Write-Host "  EVIDENCE        : staging tree at $script:Staging" -ForegroundColor Yellow
}

if ($script:Notes.Count -gt 0) {
    Write-Host ''
    Write-Host '  Notes / gaps:' -ForegroundColor Yellow
    foreach ($n in $script:Notes) { Write-Host "    - $n" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '  Done.' -ForegroundColor Green
Write-Host ''
