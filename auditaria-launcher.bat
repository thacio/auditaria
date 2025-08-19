@echo off
:: Auditaria Launcher with Native Windows UI
:: This launcher provides a GUI for selecting working directory and launch options

:: Create a temporary PowerShell script
set "TEMP_PS1=%TEMP%\auditaria_launcher_%RANDOM%.ps1"

(
echo Add-Type -AssemblyName System.Windows.Forms
echo Add-Type -AssemblyName System.Drawing
echo $ErrorActionPreference = 'Stop'
echo.
echo # Create the main form
echo $form = New-Object System.Windows.Forms.Form
echo $form.Text = 'Auditaria Launcher'
echo $form.Size = New-Object System.Drawing.Size^(540, 540^)
echo $form.MinimumSize = New-Object System.Drawing.Size^(540, 540^)
echo $form.StartPosition = 'CenterScreen'
echo $form.FormBorderStyle = 'Sizable'
echo $form.MaximizeBox = $false
echo $form.Icon = [System.Drawing.SystemIcons]::Application
echo $form.BackColor = [System.Drawing.Color]::FromArgb^(240, 240, 240^)
echo.
echo # Create title label
echo $titleLabel = New-Object System.Windows.Forms.Label
echo $titleLabel.Location = New-Object System.Drawing.Point^(20, 20^)
echo $titleLabel.Size = New-Object System.Drawing.Size^(460, 30^)
echo $titleLabel.Text = 'Auditaria - AI-Powered Audit Assistant'
echo $titleLabel.Font = New-Object System.Drawing.Font^('Segoe UI', 14, [System.Drawing.FontStyle]::Bold^)
echo $titleLabel.ForeColor = [System.Drawing.Color]::FromArgb^(0, 51, 102^)
echo $form.Controls.Add^($titleLabel^)
echo.
echo # Create working directory label
echo $dirLabel = New-Object System.Windows.Forms.Label
echo $dirLabel.Location = New-Object System.Drawing.Point^(20, 65^)
echo $dirLabel.Size = New-Object System.Drawing.Size^(150, 20^)
echo $dirLabel.Text = 'Working Directory:'
echo $dirLabel.Font = New-Object System.Drawing.Font^('Segoe UI', 10^)
echo $form.Controls.Add^($dirLabel^)
echo.
echo # Create directory textbox
echo $dirTextBox = New-Object System.Windows.Forms.TextBox
echo $dirTextBox.Location = New-Object System.Drawing.Point^(20, 90^)
echo $dirTextBox.Size = New-Object System.Drawing.Size^(380, 25^)
echo $dirTextBox.Text = [Environment]::GetFolderPath^('MyDocuments'^)
echo $dirTextBox.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $form.Controls.Add^($dirTextBox^)
echo.
echo # Create browse button
echo $browseButton = New-Object System.Windows.Forms.Button
echo $browseButton.Location = New-Object System.Drawing.Point^(410, 89^)
echo $browseButton.Size = New-Object System.Drawing.Size^(75, 27^)
echo $browseButton.Text = 'Browse...'
echo $browseButton.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $browseButton.FlatStyle = 'Standard'
echo $browseButton.Add_Click^({
echo     $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
echo     $folderBrowser.Description = 'Select the folder where Auditaria will have access'
echo     $folderBrowser.SelectedPath = $dirTextBox.Text
echo     $folderBrowser.ShowNewFolderButton = $true
echo     if ^($folderBrowser.ShowDialog^(^) -eq 'OK'^) {
echo         $dirTextBox.Text = $folderBrowser.SelectedPath
echo     }
echo }^)
echo $form.Controls.Add^($browseButton^)
echo.
echo # Create launch options group box
echo $optionsGroup = New-Object System.Windows.Forms.GroupBox
echo $optionsGroup.Location = New-Object System.Drawing.Point^(20, 130^)
echo $optionsGroup.Size = New-Object System.Drawing.Size^(465, 80^)
echo $optionsGroup.Text = 'Launch Options'
echo $optionsGroup.Font = New-Object System.Drawing.Font^('Segoe UI', 10^)
echo $form.Controls.Add^($optionsGroup^)
echo.
echo # Create web interface checkbox
echo $webCheckBox = New-Object System.Windows.Forms.CheckBox
echo $webCheckBox.Location = New-Object System.Drawing.Point^(15, 25^)
echo $webCheckBox.Size = New-Object System.Drawing.Size^(430, 25^)
echo $webCheckBox.Text = 'Launch with Web Interface ^(--web^)'
echo $webCheckBox.Checked = $true
echo $webCheckBox.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $optionsGroup.Controls.Add^($webCheckBox^)
echo.
echo # Create no-browser checkbox
echo $noBrowserCheckBox = New-Object System.Windows.Forms.CheckBox
echo $noBrowserCheckBox.Location = New-Object System.Drawing.Point^(35, 50^)
echo $noBrowserCheckBox.Size = New-Object System.Drawing.Size^(410, 25^)
echo $noBrowserCheckBox.Text = 'Don''t open browser automatically ^(no-browser^)'
echo $noBrowserCheckBox.Checked = $false
echo $noBrowserCheckBox.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $noBrowserCheckBox.Enabled = $true
echo $optionsGroup.Controls.Add^($noBrowserCheckBox^)
echo.
echo # Create security group box
echo $securityGroup = New-Object System.Windows.Forms.GroupBox
echo $securityGroup.Location = New-Object System.Drawing.Point^(20, 220^)
echo $securityGroup.Size = New-Object System.Drawing.Size^(465, 55^)
echo $securityGroup.Text = 'Security Settings'
echo $securityGroup.Font = New-Object System.Drawing.Font^('Segoe UI', 10^)
echo $form.Controls.Add^($securityGroup^)
echo.
echo # Create SSL checkbox
echo $sslCheckBox = New-Object System.Windows.Forms.CheckBox
echo $sslCheckBox.Location = New-Object System.Drawing.Point^(15, 25^)
echo $sslCheckBox.Size = New-Object System.Drawing.Size^(440, 25^)
echo $sslCheckBox.Text = 'Disable SSL verification ^(for corporate firewalls with MITM^)'
echo $sslCheckBox.Checked = $false
echo $sslCheckBox.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $sslCheckBox.ForeColor = [System.Drawing.Color]::FromArgb^(139, 69, 19^)
echo $securityGroup.Controls.Add^($sslCheckBox^)
echo.
echo # Create approval mode group box
echo $approvalGroup = New-Object System.Windows.Forms.GroupBox
echo $approvalGroup.Location = New-Object System.Drawing.Point^(20, 285^)
echo $approvalGroup.Size = New-Object System.Drawing.Size^(465, 100^)
echo $approvalGroup.Text = 'Approval Mode'
echo $approvalGroup.Font = New-Object System.Drawing.Font^('Segoe UI', 10^)
echo $form.Controls.Add^($approvalGroup^)
echo.
echo # Create approval mode radio buttons
echo $approvalDefaultRadio = New-Object System.Windows.Forms.RadioButton
echo $approvalDefaultRadio.Location = New-Object System.Drawing.Point^(15, 25^)
echo $approvalDefaultRadio.Size = New-Object System.Drawing.Size^(440, 20^)
echo $approvalDefaultRadio.Text = 'Default - Prompt for approval on tool use'
echo $approvalDefaultRadio.Checked = $true
echo $approvalDefaultRadio.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $approvalGroup.Controls.Add^($approvalDefaultRadio^)
echo.
echo $approvalAutoEditRadio = New-Object System.Windows.Forms.RadioButton
echo $approvalAutoEditRadio.Location = New-Object System.Drawing.Point^(15, 48^)
echo $approvalAutoEditRadio.Size = New-Object System.Drawing.Size^(440, 20^)
echo $approvalAutoEditRadio.Text = 'Auto Edit - Auto-approve edit tools only'
echo $approvalAutoEditRadio.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $approvalGroup.Controls.Add^($approvalAutoEditRadio^)
echo.
echo $approvalYoloRadio = New-Object System.Windows.Forms.RadioButton
echo $approvalYoloRadio.Location = New-Object System.Drawing.Point^(15, 71^)
echo $approvalYoloRadio.Size = New-Object System.Drawing.Size^(440, 20^)
echo $approvalYoloRadio.Text = 'YOLO - Auto-approve all tools ^(use with caution^)'
echo $approvalYoloRadio.Font = New-Object System.Drawing.Font^('Segoe UI', 9^)
echo $approvalYoloRadio.ForeColor = [System.Drawing.Color]::FromArgb^(255, 69, 0^)
echo $approvalGroup.Controls.Add^($approvalYoloRadio^)
echo.
echo # Update no-browser checkbox state based on web checkbox
echo $webCheckBox.Add_CheckedChanged^({
echo     $noBrowserCheckBox.Enabled = $webCheckBox.Checked
echo     if ^(-not $webCheckBox.Checked^) {
echo         $noBrowserCheckBox.Checked = $false
echo     }
echo }^)
echo.
echo # Create Start button
echo $startButton = New-Object System.Windows.Forms.Button
echo $startButton.Location = New-Object System.Drawing.Point^(310, 440^)
echo $startButton.Size = New-Object System.Drawing.Size^(100, 35^)
echo $startButton.Text = 'Start Auditaria'
echo $startButton.Font = New-Object System.Drawing.Font^('Segoe UI', 10, [System.Drawing.FontStyle]::Bold^)
echo $startButton.BackColor = [System.Drawing.Color]::FromArgb^(0, 120, 212^)
echo $startButton.ForeColor = [System.Drawing.Color]::White
echo $startButton.FlatStyle = 'Flat'
echo $startButton.FlatAppearance.BorderSize = 0
echo $startButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
echo $form.Controls.Add^($startButton^)
echo.
echo # Create Cancel button
echo $cancelButton = New-Object System.Windows.Forms.Button
echo $cancelButton.Location = New-Object System.Drawing.Point^(420, 440^)
echo $cancelButton.Size = New-Object System.Drawing.Size^(85, 35^)
echo $cancelButton.Text = 'Cancel'
echo $cancelButton.Font = New-Object System.Drawing.Font^('Segoe UI', 10^)
echo $cancelButton.FlatStyle = 'Flat'
echo $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
echo $form.Controls.Add^($cancelButton^)
echo.
echo # Set form accept and cancel buttons
echo $form.AcceptButton = $startButton
echo $form.CancelButton = $cancelButton
echo.
echo # Show the dialog
echo $result = $form.ShowDialog^(^)
echo.
echo if ^($result -eq [System.Windows.Forms.DialogResult]::OK^) {
echo     $workingDir = $dirTextBox.Text
echo.
echo     # Validate directory exists
echo     if ^(-not ^(Test-Path -Path $workingDir -PathType Container^)^) {
echo         [System.Windows.Forms.MessageBox]::Show^(
echo             'The selected directory does not exist. Please choose a valid directory.',
echo             'Invalid Directory',
echo             [System.Windows.Forms.MessageBoxButtons]::OK,
echo             [System.Windows.Forms.MessageBoxIcon]::Warning
echo         ^)
echo         exit 1
echo     }
echo.
echo     # Build command line arguments
echo     $args = @^(^)
echo     if ^($webCheckBox.Checked^) {
echo         if ^($noBrowserCheckBox.Checked^) {
echo             $args += '--web', 'no-browser'
echo         } else {
echo             $args += '--web'
echo         }
echo     }
echo.
echo     # Add approval mode
echo     if ^($approvalAutoEditRadio.Checked^) {
echo         $args += '--approval-mode', 'auto_edit'
echo     } elseif ^($approvalYoloRadio.Checked^) {
echo         $args += '--approval-mode', 'yolo'
echo     }
echo     # Default mode doesn't need explicit parameter
echo.
echo     # Find the executable path
echo     $scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
echo     if ^([string]::IsNullOrEmpty^($scriptPath^)^) {
echo         $scriptPath = Get-Location
echo     }
echo     $exePath = Join-Path $scriptPath 'auditaria-standalone.exe'
echo.
echo     # Check if executable exists
echo     if ^(-not ^(Test-Path -Path $exePath^)^) {
echo         # Try in current directory
echo         $exePath = Join-Path ^(Get-Location^) 'auditaria-standalone.exe'
echo         if ^(-not ^(Test-Path -Path $exePath^)^) {
echo             [System.Windows.Forms.MessageBox]::Show^(
echo                 'auditaria-standalone.exe not found. Please ensure it is in the same directory as this launcher.',
echo                 'Executable Not Found',
echo                 [System.Windows.Forms.MessageBoxButtons]::OK,
echo                 [System.Windows.Forms.MessageBoxIcon]::Error
echo             ^)
echo             exit 1
echo         }
echo     }
echo.
echo     # Change to the selected directory and start Auditaria
echo     Set-Location -Path $workingDir
echo.
echo     # Handle SSL setting for corporate firewalls
echo     if ^($sslCheckBox.Checked^) {
echo         $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
echo         Write-Host '⚠️  SSL verification disabled for corporate firewall' -ForegroundColor Yellow
echo     }
echo.
echo     # Start the process
echo     if ^($args.Count -gt 0^) {
echo         Start-Process -FilePath $exePath -ArgumentList $args -NoNewWindow -Wait
echo     } else {
echo         Start-Process -FilePath $exePath -NoNewWindow -Wait
echo     }
echo }
) > "%TEMP_PS1%"

:: Run the PowerShell script
powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "%TEMP_PS1%"
set EXITCODE=%ERRORLEVEL%

:: Clean up the temporary file
del "%TEMP_PS1%" 2>nul

:: If PowerShell exits with error, pause to show the error
if %EXITCODE% NEQ 0 (
    echo.
    echo An error occurred while launching Auditaria.
    pause
)

exit /b %EXITCODE%