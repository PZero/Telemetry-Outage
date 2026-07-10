# deploy.ps1 — Build frontend and deploy to GitHub Pages
# Strategy: source index.html is preserved as index.src.html
#            the built index.html (with fixed asset names) overwrites root/index.html for GH Pages

# Save source template if not already done
if (-not (Test-Path "index.src.html")) {
    Copy-Item "index.html" "index.src.html"
    Write-Host "Saved source template as index.src.html" -ForegroundColor Yellow
}

Write-Host "=== Deploy: Building frontend ===" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED. Aborting deploy." -ForegroundColor Red
    # Restore source index.html so dev works again
    Copy-Item -Force "index.src.html" "index.html"
    exit 1
}

Write-Host "=== Deploy: Copying built output to root ===" -ForegroundColor Cyan
# Copy built index.html (references fixed ./assets/index.js, ./assets/index.css)
# Use index.src.html directly (avoids Vite re-encoding unicode)
Copy-Item -Force "index.src.html" ".\index.html"
# Copy built assets (no hashes! always same names)
Copy-Item -Force "dist\assets\index.js"      ".\assets\index.js"
Copy-Item -Force "dist\assets\index.css"     ".\assets\index.css"
Copy-Item -Force "dist\assets\logo.svg"      ".\assets\logo.svg"
Copy-Item -Force "dist\assets\manifest.json" ".\assets\manifest.json"

Write-Host "=== Deploy: Committing and pushing ===" -ForegroundColor Cyan
git add index.html assets/ 2>$null
git commit -m "Deploy: update built assets for GitHub Pages"
git push

Write-Host "=== Deploy: Restoring source template ===" -ForegroundColor Cyan
# Restore the source index.html so local dev (npm run dev) still works
Copy-Item -Force "index.src.html" "index.html"

Write-Host "=== Deploy: Done! GitHub Pages will update in ~1 minute. ===" -ForegroundColor Green
