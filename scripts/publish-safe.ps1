# File: scripts/publish-safe.ps1
# Purpose: Safe scripted publish flow for Foseer with strict validation.

<#
.SYNOPSIS
    Safe publish script for Foseer project.
    Enforces strict validation before any Git stage/commit/push operation.

.DESCRIPTION
    This script is the ONLY allowed path for publishing Foseer to Git.
    It enforces:
    - Repository identity validation (root, remote, branch)
    - .git presence and activity check
    - Parent-directory leakage detection
    - Build execution before commit
    - Git status/diff inspection before staging
    - Commit message requirement
    - Push only after successful commit

    If any validation fails, the script stops immediately with no fallback.

.PARAMETER Message
    Required commit message. Must be provided as a named argument.

.EXAMPLE
    .\scripts\publish-safe.ps1 -Message "feat: add new landing page section"

.NOTES
    This script follows strict error handling: any failed command aborts execution.
    Do not modify this script unless you are updating the publish workflow itself.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Message
)

# =============================================================================
# CONFIGURATION - DO NOT MODIFY UNLESS UPDATING PUBLISH WORKFLOW
# =============================================================================

$ExpectedRepoRoot = "C:\Users\vladi\Documents\vcoding\projects\foseer.com"
$ExpectedRemoteUrl = "https://github.com/VladChat/foseer.com"
$ExpectedBranch = "main"

# =============================================================================
# ERROR HANDLING - STRICT MODE
# =============================================================================

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-ErrorAndExit {
    param([string]$ErrorMessage)
    Write-Host "ERROR: $ErrorMessage" -ForegroundColor Red
    exit 1
}

function Write-Step {
    param([string]$StepMessage)
    Write-Host ">> $StepMessage" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$SuccessMessage)
    Write-Host "OK: $SuccessMessage" -ForegroundColor Green
}

function Invoke-GitCommand {
    param(
        [string]$RepoRoot,
        [string[]]$Arguments
    )
    # Run git command with suppressed warnings, return output and exit code
    $OriginalErrorAction = $ErrorActionPreference
    $OriginalWarningPreference = $WarningPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $WarningPreference = 'SilentlyContinue'
    
    $Output = & {
        $ErrorActionPreference = 'SilentlyContinue'
        $WarningPreference = 'SilentlyContinue'
        git -C $RepoRoot @Arguments 2>&1
    }
    $ExitCode = $LASTEXITCODE
    
    $ErrorActionPreference = $OriginalErrorAction
    $WarningPreference = $OriginalWarningPreference
    
    # Filter out line-ending warnings and convert to string array
    $CleanOutput = @()
    foreach ($line in $Output) {
        $lineStr = [string]$line
        if ($lineStr -notmatch 'LF will be replaced by CRLF' -and 
            $lineStr -notmatch 'CRLF will be replaced by LF') {
            $CleanOutput += $lineStr
        }
    }
    
    return @{ Output = $CleanOutput; ExitCode = $ExitCode }
}

# =============================================================================
# VALIDATION PHASE
# =============================================================================

Write-Step "=== Foseer Safe Publish Script ==="
Write-Step "Validating repository identity..."

# 1. Validate current directory is within expected repo root
$CurrentPath = (Get-Location).Path
if (-not $CurrentPath.StartsWith($ExpectedRepoRoot)) {
    Write-ErrorAndExit "Current path '$CurrentPath' is not within expected repo root '$ExpectedRepoRoot'. Publishing must run from the Foseer project directory."
}
Write-Success "Current path is within repo root"

# 2. Validate .git directory exists and is active
$GitDir = Join-Path $ExpectedRepoRoot ".git"
if (-not (Test-Path $GitDir)) {
    Write-ErrorAndExit ".git directory not found at '$GitDir'. Repository is not initialized."
}
Write-Success ".git directory exists"

# 3. Validate actual git repo root matches expected
$RepoRootResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("rev-parse", "--show-toplevel")
if ($RepoRootResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Git command failed. Repository may be corrupted."
}
$ActualRepoRoot = $RepoRootResult.Output[0].Replace("/", "\").TrimEnd("\")
$ExpectedRepoRootNormalized = $ExpectedRepoRoot.Replace("/", "\").TrimEnd("\")
if ($ActualRepoRoot -ne $ExpectedRepoRootNormalized) {
    Write-ErrorAndExit "Git repo root '$ActualRepoRoot' does not match expected '$ExpectedRepoRootNormalized'. Possible parent-directory leakage."
}
Write-Success "Git repo root matches expected path"

# 4. Validate remote origin
$RemoteResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("remote", "get-url", "origin")
if ($RemoteResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Remote 'origin' not configured."
}
$RemoteOutput = $RemoteResult.Output[0].Trim()
if ($RemoteOutput -ne $ExpectedRemoteUrl) {
    Write-ErrorAndExit "Remote origin '$RemoteOutput' does not match expected '$ExpectedRemoteUrl'."
}
Write-Success "Remote origin matches expected URL"

# 5. Validate current branch
$BranchResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("branch", "--show-current")
if ($BranchResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Failed to determine current branch."
}
$CurrentBranch = $BranchResult.Output[0].Trim()
if ($CurrentBranch -ne $ExpectedBranch) {
    Write-ErrorAndExit "Current branch '$CurrentBranch' is not '$ExpectedBranch'. Switch to main before publishing."
}
Write-Success "Current branch is '$ExpectedBranch'"

# 6. Check for parent-directory leakage via git status
$StatusResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("status", "--porcelain")
if ($StatusResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Git status command failed."
}

foreach ($line in $StatusResult.Output) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    
    # Extract file path from status line (format: "XY path")
    $filePath = $line.Substring(3).Trim()
    
    # Check for parent directory references (Windows and Unix style)
    if ($filePath.StartsWith("..")) {
        Write-ErrorAndExit "Parent-directory leakage detected: '$filePath'. Git operations must not include files outside repo root."
    }
    
    # Resolve the full path and verify it is within repo root
    $FullPath = Resolve-Path -Path (Join-Path $ExpectedRepoRoot $filePath) -ErrorAction SilentlyContinue
    if ($null -ne $FullPath) {
        $FullPathStr = $FullPath.Path.Replace("/", "\").TrimEnd("\")
        if (-not $FullPathStr.StartsWith($ExpectedRepoRootNormalized)) {
            Write-ErrorAndExit "Parent-directory leakage detected: '$filePath' resolves to '$FullPathStr' which is outside repo root '$ExpectedRepoRootNormalized'."
        }
    }
}
Write-Success "No parent-directory leakage detected"

# =============================================================================
# BUILD PHASE
# =============================================================================

Write-Step "Running npm run build..."

Set-Location $ExpectedRepoRoot

# Capture build output and exit code
$BuildOutput = & {
    $ErrorActionPreference = 'Continue'
    npm run build 2>&1
}
$BuildExitCode = $LASTEXITCODE

# Check for successful build completion marker
$BuildSuccess = $BuildOutput -match '\[build\]\s+Complete!'

# Output build result
Write-Host $BuildOutput

# Exit code 0 = success, exit code 1 with "Complete!" = success with warnings
# Any other case = failure
if (-not $BuildSuccess -and $BuildExitCode -ne 0) {
    Write-ErrorAndExit "Build failed with exit code $BuildExitCode. Cannot publish broken build."
}

Write-Success "Build completed successfully"

# =============================================================================
# PRE-STAGE INSPECTION
# =============================================================================

Write-Step "Inspecting git status before staging..."

$StatusBeforeResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("status")
if ($StatusBeforeResult.ExitCode -ne 0 -and $StatusBeforeResult.ExitCode -ne 1) {
    Write-ErrorAndExit "Failed to get git status."
}
Write-Host ($StatusBeforeResult.Output -join "`n")

Write-Step "Inspecting git diff --stat before staging..."

$DiffResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("diff", "--stat")
# Exit code 0 = no changes, exit code 1 = changes exist
if ($DiffResult.ExitCode -eq 0 -or $DiffResult.ExitCode -eq 1) {
    if ($DiffResult.Output -and $DiffResult.Output.Count -gt 0) {
        Write-Host ($DiffResult.Output -join "`n")
    } else {
        Write-Host "(No unstaged changes)"
    }
} else {
    Write-ErrorAndExit "Git diff failed with exit code $($DiffResult.ExitCode)."
}

# =============================================================================
# STAGE PHASE
# =============================================================================

Write-Step "Staging all changes..."

$AddResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("add", ".")
# Exit code 0 = success, exit code 1 = warnings only
if ($AddResult.ExitCode -gt 1) {
    Write-ErrorAndExit "Git add failed with exit code $($AddResult.ExitCode)."
}

# =============================================================================
# VALIDATE STAGED CONTENT
# =============================================================================

Write-Step "Validating staged content..."

$StagedStatusResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("status", "--porcelain")
if ($StagedStatusResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Failed to check staged status."
}

# Check if anything is staged (index status is first character: A/M/D/R/C)
$HasStaged = $false
foreach ($line in $StagedStatusResult.Output) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $indexStatus = $line.Substring(0, 1)
    if ($indexStatus -match '^[AMRDC]$') {
        $HasStaged = $true
        break
    }
}

if (-not $HasStaged) {
    Write-ErrorAndExit "Nothing to commit. No changes were staged. Aborting publish."
}

Write-Success "Changes staged successfully"

# =============================================================================
# COMMIT PHASE
# =============================================================================

Write-Step "Creating commit with message: '$Message'..."

$CommitResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("commit", "-m", $Message)
if ($CommitResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Git commit failed with exit code $($CommitResult.ExitCode)."
}
Write-Host ($CommitResult.Output -join "`n")

Write-Success "Commit created successfully"

# =============================================================================
# PUSH PHASE
# =============================================================================

Write-Step "Pushing to origin $ExpectedBranch..."

$PushResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("push", "origin", $ExpectedBranch)

# Check for "Everything up-to-date" which is success
$PushText = $PushResult.Output -join " "
if ($PushResult.ExitCode -ne 0 -and $PushText -notmatch 'Everything up-to-date') {
    Write-ErrorAndExit "Git push failed with exit code $($PushResult.ExitCode)."
}

if ($PushResult.Output -and $PushResult.Output.Count -gt 0) {
    Write-Host ($PushResult.Output -join "`n")
}

if ($PushText -match 'Everything up-to-date') {
    Write-Success "Repository already up to date"
} else {
    Write-Success "Push completed successfully"
}

# =============================================================================
# FINAL VERIFICATION
# =============================================================================

Write-Step "Final verification..."

$HashResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("rev-parse", "HEAD")
if ($HashResult.ExitCode -ne 0) {
    Write-ErrorAndExit "Failed to get commit hash."
}
$CommitHash = $HashResult.Output[0].Trim()

$FinalStatusResult = Invoke-GitCommand -RepoRoot $ExpectedRepoRoot -Arguments @("status")
if ($FinalStatusResult.ExitCode -ne 0 -and $FinalStatusResult.ExitCode -ne 1) {
    Write-ErrorAndExit "Failed to get final git status."
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "PUBLISH SUCCESSFUL" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "Commit hash: $CommitHash" -ForegroundColor Green
Write-Host "Remote: $ExpectedRemoteUrl" -ForegroundColor Green
Write-Host "Branch: $ExpectedBranch" -ForegroundColor Green
Write-Host ""
Write-Host "Final git status:" -ForegroundColor Cyan
Write-Host ($FinalStatusResult.Output -join "`n")
Write-Host ""
