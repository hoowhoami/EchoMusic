!macro customInit
  ; 安装前强制结束残留的 EchoMusic 进程（包括卸载程序）
  ; 解决卸载后重新安装时 "Uninstall EchoMusic.exe" 被锁定的问题
  nsExec::ExecToStack 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  nsExec::ExecToStack 'taskkill /F /IM "Uninstall ${PRODUCT_NAME}.exe" /T'

  ; 等待进程完全退出
  Sleep 1000

  ; 尝试删除被锁定的卸载程序
  Delete "$INSTDIR\\Uninstall ${PRODUCT_NAME}.exe"

  ; 如果仍然删除失败，尝试重命名（Windows 允许重命名被锁定的文件）
  IfFileExists "$INSTDIR\\Uninstall ${PRODUCT_NAME}.exe" 0 +2
    Rename "$INSTDIR\\Uninstall ${PRODUCT_NAME}.exe" "$INSTDIR\\Uninstall ${PRODUCT_NAME}.exe.old"
!macroend

!macro customInstall
  ; 清理重命名的旧卸载程序
  Delete "$INSTDIR\\Uninstall ${PRODUCT_NAME}.exe.old"

  Delete "$DESKTOP\\${PRODUCT_NAME}.lnk"
  CreateShortCut "$DESKTOP\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--no-sandbox"

  Delete "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk"
  CreateShortCut "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--no-sandbox"
!macroend
