' Starts Song Bot without a console window. Use start-debug.bat if you need to see errors.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FolderExists(sh.CurrentDirectory & "\node_modules") Then
  ' First run: show the installer window so you can see progress (takes a few minutes).
  sh.Run "cmd /c echo First run - installing dependencies... && npm install", 1, True
End If

sh.Run "cmd /c npm start", 0, False
