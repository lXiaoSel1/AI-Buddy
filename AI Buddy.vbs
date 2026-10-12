Option Explicit
Dim shell, fileSystem, rootPath, command, result
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
rootPath = fileSystem.GetParentFolderName(WScript.ScriptFullName)
If fileSystem.FileExists(rootPath & "\AI Buddy.exe") Then
  command = Chr(34) & rootPath & "\AI Buddy.exe" & Chr(34)
Else
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & rootPath & "\Start-AI-Buddy.ps1" & Chr(34)
End If
result = shell.Run(command, 0, True)
If result <> 0 Then MsgBox "AI Buddy could not start. Please extract the complete ZIP and run AI Buddy.cmd to view the error.", vbExclamation, "AI Buddy"
