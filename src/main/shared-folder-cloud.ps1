$ErrorActionPreference = 'Stop'
# Read only public Cloud Files state. No account databases or tokens are used.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class SharedFolderCloudState {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct FindData {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint SizeHigh, SizeLow, ReparseTag, Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindFirstFile(string filename, out FindData data);
    [DllImport("kernel32.dll")] public static extern bool FindClose(IntPtr handle);
    [DllImport("cldapi.dll")] public static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes, uint tag);
    public static uint State(string filename) {
        FindData data;
        var handle = FindFirstFile(filename, out data);
        if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        try { return CfGetPlaceholderStateFromAttributeTag(data.Attributes, data.ReparseTag); }
        finally { FindClose(handle); }
    }
}
'@
$files = @((Get-Item -LiteralPath $env:SHAREMAP_FILE))
$files += @(Get-ChildItem -LiteralPath $env:SHAREMAP_JOURNAL -File -Filter '*.json' | Select-Object -First 10000)
$states = @($files | ForEach-Object {
    $entryName = $_.Name
    try {
        $state = [SharedFolderCloudState]::State($_.FullName)
        [pscustomobject]@{name=$_.Name; placeholder=($state -band 1) -ne 0; inSync=($state -band 8) -ne 0}
    } catch {
        [pscustomobject]@{name=$entryName; error='Windows could not read the Cloud Files state'}
    }
})
[pscustomobject]@{supported=$true; checkedAt=[DateTime]::UtcNow.ToString('o'); files=$states} | ConvertTo-Json -Depth 4 -Compress
