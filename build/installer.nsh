!macro customInstall
  Delete "$DESKTOP\\${PRODUCT_NAME}.lnk"
  CreateShortCut "$DESKTOP\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--no-sandbox"

  Delete "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk"
  CreateShortCut "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--no-sandbox"
!macroend
