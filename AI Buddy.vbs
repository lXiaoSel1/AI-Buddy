Option Explicit
Dim shell, fileSystem, rootPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
rootPath = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & rootPath & "\Start-AI-Buddy.ps1" & Chr(34)
shell.Run command, 0, False
