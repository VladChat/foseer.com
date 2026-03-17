# File: scripts/run-content-pipeline.ps1
# Purpose: Beginner-friendly PowerShell wrapper for Foseer content pipeline

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Foseer Content Pipeline" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Change to project root
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "Project: $projectRoot" -ForegroundColor Gray
Write-Host ""

# Parse arguments
$dryRun = $args.Contains('--dry-run') -or $args.Contains('-n')
$imagesOnly = $args.Contains('--images-only')
$verifyOnly = $args.Contains('--verify-only')
$help = $args.Contains('--help') -or $args.Contains('-h')

# Build node command
$nodeArgs = @("scripts/run-content-pipeline.js")

if ($dryRun) { $nodeArgs += '--dry-run' }
if ($imagesOnly) { $nodeArgs += '--images-only' }
if ($verifyOnly) { $nodeArgs += '--verify-only' }
if ($help) {
    node $nodeArgs[0] --help
    exit 0
}

# Run the pipeline
Write-Host "Running pipeline..." -ForegroundColor Green
Write-Host ""

try {
    $output = node $nodeArgs 2>&1

    # Colorize output
    foreach ($line in $output) {
        if ($line -match '✓|SUCCESS|Complete') {
            Write-Host $line -ForegroundColor Green
        } elseif ($line -match '✗|ERROR|Failed') {
            Write-Host $line -ForegroundColor Red
        } elseif ($line -match '⚠️|WARNING') {
            Write-Host $line -ForegroundColor Yellow
        } elseif ($line -match '🚀|📁|📸|🔍|🔨|📊') {
            Write-Host $line -ForegroundColor Cyan
        } else {
            Write-Host $line
        }
    }

    $exitCode = $LASTEXITCODE
} catch {
    Write-Host "Pipeline failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

if ($exitCode -eq 0) {
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  Pipeline completed successfully!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
} else {
    Write-Host "============================================" -ForegroundColor Red
    Write-Host "  Pipeline completed with errors" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Red
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Check generated images in src/assets/images/posts/" -ForegroundColor White
Write-Host "  2. Run 'npm run dev' to preview the site" -ForegroundColor White
Write-Host "  3. Commit generated image files to git" -ForegroundColor White
Write-Host ""

exit $exitCode