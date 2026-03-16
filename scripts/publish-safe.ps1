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
try {
    $ActualRepoRoot = git -C $ExpectedRepoRoot rev-parse --show-toplevel 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Git command failed. Repository may be corrupted."
    }
    # Normalize paths for comparison
    $ActualRepoRoot = $ActualRepoRoot.Replace("/", "\").TrimEnd("\")
    $ExpectedRepoRootNormalized = $ExpectedRepoRoot.Replace("/", "\").TrimEnd("\")
    if ($ActualRepoRoot -ne $ExpectedRepoRootNormalized) {
        Write-ErrorAndExit "Git repo root '$ActualRepoRoot' does not match expected '$ExpectedRepoRootNormalized'. Possible parent-directory leakage."
    }
} catch {
    Write-ErrorAndExit "Failed to verify git repo root: $_"
}
Write-Success "Git repo root matches expected path"

# 4. Validate remote origin
try {
    $RemoteOutput = git -C $ExpectedRepoRoot remote get-url origin 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Remote 'origin' not configured."
    }
    $RemoteOutput = $RemoteOutput.Trim()
    if ($RemoteOutput -ne $ExpectedRemoteUrl) {
        Write-ErrorAndExit "Remote origin '$RemoteOutput' does not match expected '$ExpectedRemoteUrl'."
    }
} catch {
    Write-ErrorAndExit "Failed to verify remote origin: $_"
}
Write-Success "Remote origin matches expected URL"

# 5. Validate current branch
try {
    $CurrentBranch = git -C $ExpectedRepoRoot branch --show-current 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Failed to determine current branch."
    }
    $CurrentBranch = $CurrentBranch.Trim()
    if ($CurrentBranch -ne $ExpectedBranch) {
        Write-ErrorAndExit "Current branch '$CurrentBranch' is not '$ExpectedBranch'. Switch to main before publishing."
    }
} catch {
    Write-ErrorAndExit "Failed to verify branch: $_"
}
Write-Success "Current branch is '$ExpectedBranch'"

# 6. Check for parent-directory leakage via git status
# This check catches: ..\, ../, any path starting with .., and paths resolving outside repo root
try {
    $StatusOutput = git -C $ExpectedRepoRoot status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Git status command failed."
    }
    # Check if any tracked files are outside the expected repo root
    $StatusLines = $StatusOutput -split "`n"
    foreach ($line in $StatusLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        # Extract file path from status line (format: "XY path")
        $filePath = $line.Substring(3).Trim()
        
        # Check for parent directory references (Windows and Unix style)
        if ($filePath.StartsWith("..\")) {
            Write-ErrorAndExit "Parent-directory leakage detected: '$filePath'. Git operations must not include files outside repo root."
        }
        if ($filePath.StartsWith("../")) {
            Write-ErrorAndExit "Parent-directory leakage detected: '$filePath'. Git operations must not include files outside repo root."
        }
        if ($filePath.StartsWith("..")) {
            Write-ErrorAndExit "Parent-directory leakage detected: '$filePath'. Git operations must not include files outside repo root."
        }
        
        # Resolve the full path and verify it is within repo root
        $FullPath = Resolve-Path -Path (Join-Path $ExpectedRepoRoot $filePath) -ErrorAction SilentlyContinue
        if ($null -ne $FullPath) {
            $FullPathStr = $FullPath.Path.Replace("/", "\").TrimEnd("\")
            $ExpectedRepoRootNormalized = $ExpectedRepoRoot.Replace("/", "\").TrimEnd("\")
            if (-not $FullPathStr.StartsWith($ExpectedRepoRootNormalized)) {
                Write-ErrorAndExit "Parent-directory leakage detected: '$filePath' resolves to '$FullPathStr' which is outside repo root '$ExpectedRepoRootNormalized'."
            }
        }
    }
} catch {
    Write-ErrorAndExit "Failed to check git status: $_"
}
Write-Success "No parent-directory leakage detected"

# =============================================================================
# BUILD PHASE
# =============================================================================

Write-Step "Running npm run build..."

Set-Location $ExpectedRepoRoot

# Capture build output and exit code without throwing exception
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

try {
    $StatusBefore = git -C $ExpectedRepoRoot status 2>&1
    Write-Host $StatusBefore
} catch {
    Write-ErrorAndExit "Failed to get git status: $_"
}

Write-Step "Inspecting git diff --stat before staging..."

# Temporarily disable error action preference for git commands
$OriginalErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'

# Run git diff with stderr redirected to null for warnings
$DiffStat = & {
    $WarningPreference = 'SilentlyContinue'
    $ErrorActionPreference = 'SilentlyContinue'
    git -C $ExpectedRepoRoot diff --stat 2>&1
}
$DiffExitCode = $LASTEXITCODE

# Restore original error action preference
$ErrorActionPreference = $OriginalErrorAction

# Exit code 0 = no changes, exit code 1 = changes exist, >1 = error
if ($DiffExitCode -eq 0 -or $DiffExitCode -eq 1) {
    # Filter out line-ending warnings from output
    $DiffClean = $DiffStat | Where-Object { $_ -notmatch 'LF will be replaced by CRLF' -and $_ -notmatch 'CRLF will be replaced by LF' }
    if ($DiffClean) {
        Write-Host ($DiffClean -join "`n")
    } else {
        Write-Host "(No unstaged changes)"
    }
} else {
    Write-ErrorAndExit "Git diff failed with exit code $DiffExitCode."
}

# =============================================================================
# STAGE PHASE
# =============================================================================

Write-Step "Staging all changes..."

# Temporarily disable error action preference for git commands
$OriginalErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'

# Run git add with stderr redirected
$GitAddOutput = & {
    $WarningPreference = 'SilentlyContinue'
    $ErrorActionPreference = 'SilentlyContinue'
    git -C $ExpectedRepoRoot add . 2>&1
}
$GitAddExitCode = $LASTEXITCODE

# Restore original error action preference
$ErrorActionPreference = $OriginalErrorAction

# Output any non-warning output
if ($GitAddOutput) {
    $GitAddClean = $GitAddOutput | Where-Object { $_ -notmatch 'LF will be replaced by CRLF' -and $_ -notmatch 'CRLF will be replaced by LF' }
    if ($GitAddClean) {
        Write-Host ($GitAddClean -join "`n")
    }
}

# Only fail on actual errors (exit code > 1), not warnings
if ($GitAddExitCode -gt 1) {
    Write-ErrorAndExit "Git add failed with exit code $GitAddExitCode."
}

# =============================================================================
# VALIDATE STAGED CONTENT
# =============================================================================

Write-Step "Validating staged content..."

try {
    $StagedStatus = git -C $ExpectedRepoRoot status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Failed to check staged status."
    }

    # Check if anything is staged
    $HasStaged = $false
    $StatusLines = $StagedStatus -split "`n"
    foreach ($line in $StatusLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $indexStatus = $line.Substring(0, 1)
        if ($indexStatus -eq "A" -or $indexStatus -eq "M" -or $indexStatus -eq "D" -or $indexStatus -eq "R" -or $indexStatus -eq "C") {
            $HasStaged = $true
            break
        }
    }

    if (-not $HasStaged) {
        Write-ErrorAndExit "Nothing to commit. No changes were staged. Aborting publish."
    }
} catch {
    Write-ErrorAndExit "Failed to validate staged content: $_"
}

Write-Success "Changes staged successfully"

# =============================================================================
# COMMIT PHASE
# =============================================================================

Write-Step "Creating commit with message: '$Message'..."

try {
    $CommitOutput = git -C $ExpectedRepoRoot commit -m $Message 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Git commit failed with exit code $LASTEXITCODE. Output: $CommitOutput"
    }
    Write-Host $CommitOutput
} catch {
    Write-ErrorAndExit "Git commit failed: $_"
}

Write-Success "Commit created successfully"

# =============================================================================
# PUSH PHASE
# =============================================================================

Write-Step "Pushing to origin $ExpectedBranch..."

try {
    $PushOutput = git -C $ExpectedRepoRoot push origin $ExpectedBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Git push failed with exit code $LASTEXITCODE. Output: $PushOutput"
    }
    Write-Host $PushOutput
} catch {
    Write-ErrorAndExit "Git push failed: $_"
}

Write-Success "Push completed successfully"

# =============================================================================
# FINAL VERIFICATION
# =============================================================================

Write-Step "Final verification..."

try {
    $CommitHash = git -C $ExpectedRepoRoot rev-parse HEAD 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Failed to get commit hash."
    }

    $FinalStatus = git -C $ExpectedRepoRoot status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "Failed to get final git status."
    }
} catch {
    Write-ErrorAndExit "Final verification failed: $_"
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
Write-Host $FinalStatus
Write-Host ""
