param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$testDirectory = Join-Path $env:TEMP ('drawio-sync-install-test-' + [guid]::NewGuid())
$classId = 'drawio-desktop-sync.drawio'
$classPath = 'HKCU:\Software\Classes\' + $classId
$extensionPath = 'HKCU:\Software\Classes\.drawio'
$appKey = 'HKCU:\Software\drawio-desktop-sync'
if (Test-Path -LiteralPath $appKey) { throw 'Installer test requires an account without an installed drawio-desktop-sync' }
$previousClass = if (Test-Path -LiteralPath $extensionPath) { (Get-Item -LiteralPath $extensionPath).GetValue('') } else { $null }
$installedExe = Join-Path $testDirectory 'drawio-desktop-sync.exe'
$uninstaller = Join-Path $testDirectory 'Uninstall drawio-desktop-sync.exe'

function Assert-Equal($Actual, $Expected, [string]$Label)
{
	if ($Actual -cne $Expected) { throw "$Label expected [$Expected], got [$Actual]" }
}
function Install-TestApp
{
	$process = Start-Process -FilePath $installerPath -ArgumentList "/S /currentuser /D=$testDirectory" -WindowStyle Hidden -PassThru
	if (-not $process.WaitForExit(120000)) { throw 'Installer timed out' }
	if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
}
function Uninstall-TestApp
{
	if (Test-Path -LiteralPath $uninstaller)
	{
		$process = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -WindowStyle Hidden -PassThru
		if (-not $process.WaitForExit(60000)) { throw 'Uninstaller timed out' }
		$deadline = [DateTime]::UtcNow.AddSeconds(30)
		while ((Test-Path -LiteralPath $classPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
		if (Test-Path -LiteralPath $classPath) { throw 'Uninstaller did not remove the fork handler' }
	}
}

try
{
	Install-TestApp
	if (-not (Test-Path -LiteralPath $installedExe)) { throw 'Installed application is missing' }
	if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing' }
	$expectedCommand = '"' + $installedExe + '" "%1"'
	Assert-Equal (Get-Item -LiteralPath ($classPath + '\shell\open\command')).GetValue('') $expectedCommand 'Quoted open command'
	Assert-Equal (Get-Item -LiteralPath $extensionPath).GetValue('') $classId 'Diagram handler'
	Assert-Equal (Get-Item -LiteralPath ($appKey + '\Capabilities\FileAssociations')).GetValue('.drawio') $classId 'Default apps capability'
	Assert-Equal (Get-Item -LiteralPath 'HKCU:\Software\RegisteredApplications').GetValue('drawio-desktop-sync') 'Software\drawio-desktop-sync\Capabilities' 'Registered application'
	Assert-Equal (Get-Item -LiteralPath ($appKey + '\Installer')).GetValue('PreviousDrawioClass') ([string]$previousClass) 'Original handler backup'
	$appClass = 'HKCU:\Software\Classes\Applications\drawio-desktop-sync.exe'
	Assert-Equal (Get-Item -LiteralPath ($appClass + '\shell\open\command')).GetValue('') $expectedCommand 'Open with command'
	if ((Get-Item -LiteralPath ($appClass + '\SupportedTypes')).GetValueNames() -notcontains '.drawio') { throw 'Open with registration is missing .drawio' }
	if ((Get-Item -LiteralPath ($extensionPath + '\OpenWithProgids')).GetValueNames() -notcontains $classId) { throw 'OpenWithProgids entry missing' }
	$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'drawio-desktop-sync.lnk'
	$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'drawio-desktop-sync.lnk'
	if (-not (Test-Path -LiteralPath $desktopLink)) { throw 'Desktop shortcut missing' }
	if (-not (Test-Path -LiteralPath $startLink)) { throw 'Start menu shortcut missing' }

	Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SyncAssociationProbe {
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
    public static extern uint AssocQueryString(uint flags, uint value, string association, string extra, StringBuilder output, ref uint length);
}
'@
	[uint32]$length = 32768
	$resolved = [System.Text.StringBuilder]::new([int]$length)
	$result = [SyncAssociationProbe]::AssocQueryString(0, 2, $classId, 'open', $resolved, [ref]$length)
	Assert-Equal $result ([uint32]0) 'Windows handler resolution'
	Assert-Equal $resolved.ToString() $installedExe 'Windows resolved application'
	Write-Output 'PASS: installer, shortcuts, Open with, Default apps and quoted file handler'

	Install-TestApp
	Assert-Equal (Get-Item -LiteralPath $extensionPath).GetValue('') $classId 'Upgraded diagram handler'
	Assert-Equal (Get-Item -LiteralPath ($appKey + '\Installer')).GetValue('PreviousDrawioClass') ([string]$previousClass) 'Backup retained after reinstall'
	Write-Output 'PASS: reinstall preserves the original handler backup'

	Uninstall-TestApp
	$restored = if (Test-Path -LiteralPath $extensionPath) { (Get-Item -LiteralPath $extensionPath).GetValue('') } else { $null }
	Assert-Equal ([string]$restored) ([string]$previousClass) 'Original handler restored'
	if (Test-Path -LiteralPath $appKey) { throw 'Fork capability registration was not removed' }
	if ((Get-Item -LiteralPath 'HKCU:\Software\RegisteredApplications').GetValue('drawio-desktop-sync')) { throw 'RegisteredApplications entry was not removed' }
	Write-Output 'PASS: uninstall removes fork registrations and restores the previous handler'
}
finally
{
	Uninstall-TestApp
	# Only the UUID directory created by this test may be removed.
	$resolvedTest = [IO.Path]::GetFullPath($testDirectory)
	$resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
	if (-not $resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
	if (Test-Path -LiteralPath $resolvedTest) { Remove-Item -LiteralPath $resolvedTest -Recurse -Force }
}
