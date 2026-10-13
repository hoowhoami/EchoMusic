!macro customInit
  ; 安装前强制结束残留的 EchoMusic 进程（包括卸载程序）
  ; 解决卸载后重新安装时 "Uninstall EchoMusic.exe" 被锁定的问题
  nsExec::ExecToStack 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  nsExec::ExecToStack 'taskkill /F /IM "Uninstall ${PRODUCT_NAME}.exe" /T'

  ; taskkill 返回后文件锁可能仍需一点时间释放，循环删除直到成功或超时。
  StrCpy $0 0
  uninstall_wait_loop:
    Delete "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
    IfFileExists "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe" 0 uninstall_wait_done
    IntOp $0 $0 + 1
    IntCmp $0 30 uninstall_wait_done 0 uninstall_wait_done
    Sleep 500
    Goto uninstall_wait_loop
  uninstall_wait_done:
!macroend

!macro customInstall
  ; Electron checks sandbox access before the main-process code can run.
  ; Grant Program Files-equivalent access after extraction and before launch,
  ; including silent upgrades. Use the SID so this works on every Windows locale.
  ; /grant adds RX without replacing existing permissions; OI/CI cover child files.
  Push $0
  Push $1
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    SetDetailsPrint both
    DetailPrint "Failed to grant sandbox read/execute access to $INSTDIR (icacls: $0)."
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP 'Unable to grant Windows sandbox access to "$INSTDIR" (icacls: $0).$\r$\n$\r$\nRun the installer as administrator, or grant access manually and reinstall:$\r$\nicacls "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)"' /SD IDOK
    Pop $1
    Pop $0
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $1
  Pop $0

  ; 清理历史版本可能遗留的旧卸载程序
  Delete "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe.old"

  ; Electron 43 on Windows can abort before app code starts if the NUL device is
  ; unavailable. Pass --no-stdio-init from shortcuts so startup reaches main.
  Delete "$newDesktopLink"
  CreateShortCut "$newDesktopLink" "$appExe" "--no-sandbox --no-stdio-init" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "--no-sandbox --no-stdio-init" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
!macroend
