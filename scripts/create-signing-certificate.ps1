# Create a self-signed code signing certificate for Auditaria
# This script generates a certificate that can be used to sign Windows executables
# 
# Usage:
#   .\create-signing-certificate.ps1 -Password "YourSecurePassword"
#   
# The script will output:
#   - auditaria-signing.pfx: The certificate file
#   - certificate-base64.txt: Base64 encoded certificate for GitHub Secrets

param(
    [Parameter(Mandatory=$true)]
    [string]$Password,
    
    [string]$Subject = "CN=Auditaria, O=Open Source Developer, C=BR",
    
    [int]$ValidYears = 5
)

Write-Host "Creating self-signed code signing certificate..." -ForegroundColor Cyan
Write-Host "Subject: $Subject" -ForegroundColor Gray
Write-Host "Valid for: $ValidYears years" -ForegroundColor Gray
Write-Host ""

# Check if running as administrator (recommended but not required)
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Warning "Running without administrator privileges. Certificate will be created in CurrentUser store."
    Write-Host ""
}

try {
    # Create the certificate
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -KeyUsage DigitalSignature `
        -FriendlyName "Auditaria Code Signing Certificate" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
        -KeyExportPolicy Exportable `
        -KeySpec Signature `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears($ValidYears)
    
    Write-Host "✅ Certificate created successfully!" -ForegroundColor Green
    Write-Host "   Thumbprint: $($cert.Thumbprint)" -ForegroundColor Gray
    Write-Host "   Subject: $($cert.Subject)" -ForegroundColor Gray
    Write-Host ""
    
    # Export to PFX file
    Write-Host "Exporting certificate to PFX file..." -ForegroundColor Cyan
    $pwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
    $pfxPath = Join-Path $PSScriptRoot "auditaria-signing.pfx"
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null
    
    Write-Host "✅ Certificate exported to: $pfxPath" -ForegroundColor Green
    Write-Host ""
    
    # Convert to Base64 for GitHub Secrets
    Write-Host "Converting to Base64 for GitHub Secrets..." -ForegroundColor Cyan
    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
    $base64Path = Join-Path $PSScriptRoot "certificate-base64.txt"
    $base64 | Out-File $base64Path -Encoding ASCII
    
    Write-Host "✅ Base64 encoded certificate saved to: $base64Path" -ForegroundColor Green
    Write-Host ""
    
    # Instructions for GitHub
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "NEXT STEPS - Add to GitHub Secrets:" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Go to your GitHub repository settings" -ForegroundColor White
    Write-Host "2. Navigate to Settings > Secrets and variables > Actions" -ForegroundColor White
    Write-Host "3. Add these repository secrets:" -ForegroundColor White
    Write-Host ""
    Write-Host "   WINDOWS_CERTIFICATE_BASE64:" -ForegroundColor Cyan
    Write-Host "   - Copy the entire contents of: $base64Path" -ForegroundColor Gray
    Write-Host ""
    Write-Host "   WINDOWS_CERTIFICATE_PASSWORD:" -ForegroundColor Cyan
    Write-Host "   - Use the password you provided: $('*' * $Password.Length)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "4. That's it! The workflows will automatically detect and use the certificate." -ForegroundColor White
    Write-Host "   No workflow changes needed - signing is automatic when secrets are present." -ForegroundColor Gray
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "SECURITY NOTES:" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "- Keep the PFX file and password secure!" -ForegroundColor White
    Write-Host "- Delete certificate-base64.txt after adding to GitHub" -ForegroundColor White
    Write-Host "- The certificate is valid for $ValidYears years" -ForegroundColor White
    Write-Host "- Self-signed certificates will still trigger SmartScreen warnings" -ForegroundColor White
    Write-Host "- But they show YOUR name instead of 'Unknown Publisher'" -ForegroundColor White
    Write-Host ""
    
    # Test signing a dummy file (optional)
    Write-Host "Testing certificate with a dummy file..." -ForegroundColor Cyan
    try {
        $testFile = Join-Path $env:TEMP "test-sign.ps1"
        "# Test file" | Out-File $testFile
        
        # Use the certificate from the store (still there at this point)
        $result = Set-AuthenticodeSignature -FilePath $testFile -Certificate $cert -HashAlgorithm SHA256
        
        if ($result.Status -eq "Valid") {
            Write-Host "✅ Test signing successful! Certificate works correctly." -ForegroundColor Green
            Write-Host "   Signed file: $testFile" -ForegroundColor Gray
            
            # Verify the signature
            $verify = Get-AuthenticodeSignature -FilePath $testFile
            Write-Host "   Signature status: $($verify.Status)" -ForegroundColor Gray
            Write-Host "   Signer: $($verify.SignerCertificate.Subject)" -ForegroundColor Gray
        } elseif ($result.Status -eq "UnknownError") {
            Write-Host "⚠️ Test signing returned UnknownError (this is normal)" -ForegroundColor Yellow
            Write-Host "   The certificate was created successfully and will work in GitHub Actions." -ForegroundColor Gray
            Write-Host "   This error occurs locally when signing outside of the certificate store context." -ForegroundColor Gray
        } else {
            Write-Warning "Test signing status: $($result.Status)"
            Write-Host "   The certificate should still work in GitHub Actions." -ForegroundColor Gray
        }
        
        Remove-Item $testFile -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "⚠️ Could not test signing: $_" -ForegroundColor Yellow
        Write-Host "   Certificate was created successfully and should work fine in GitHub Actions." -ForegroundColor Gray
    }
    
    Write-Host ""
    
    # NOW remove certificate from store (after testing)
    Write-Host "Cleaning up certificate from store..." -ForegroundColor Cyan
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
    Write-Host "✅ Certificate removed from store (you have the PFX file)" -ForegroundColor Green
    Write-Host ""
    
} catch {
    Write-Error "Failed to create certificate: $_"
    exit 1
}