# Publishes DSR Texture Editor as one self-contained exe (no .NET install needed) in dist\.
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
dotnet publish (Join-Path $root 'src\DSR-texture-editor.csproj') -c Release -o $dist --nologo -v q
if ($LASTEXITCODE) { throw "publish failed ($LASTEXITCODE)" }
Get-ChildItem $dist | ForEach-Object { "{0,12:n0}  {1}" -f $_.Length, $_.Name }
# Only the exe is shipped: the SDK also drops the packages' XML docs, SoulsFormats' pdb and a web.config beside it.
Get-ChildItem $dist -Exclude '*.exe' | Remove-Item -Force
"-> $(Join-Path $dist 'DSR-texture-editor.exe')"
