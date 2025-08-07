# Windows Installation Guide for Wassette

## Installation

For Windows, use this PowerShell script to install Wassette:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; iex (irm https://raw.githubusercontent.com/microsoft/wassette/main/install.ps1)
```

### Alternative Installation Methods

If the PowerShell script doesn't work, you can manually download the latest release:

1. Visit the [GitHub Releases page](https://github.com/microsoft/wassette/releases)
2. Download the appropriate `.zip` file for your architecture:
   - `wassette_*_windows_amd64.zip` for 64-bit Intel/AMD processors
   - `wassette_*_windows_arm64.zip` for ARM64 processors
3. Extract the `wassette.exe` file to a directory in your PATH

## Verification

After installation, verify that Wassette is working correctly:

```powershell
# Check that wassette is installed and accessible
wassette --version
wassette --help

# Check installation location
(Get-Command wassette).Source
```

## Uninstalling Wassette

To completely remove Wassette from your Windows system:

```powershell
# Remove the installation directory
Remove-Item "$env:LOCALAPPDATA\wassette" -Recurse -Force

# Remove from PATH (restart PowerShell after this)
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
$newPath = ($userPath -split ';' | Where-Object { $_ -notlike "*wassette*" }) -join ';'
[Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
```
