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
