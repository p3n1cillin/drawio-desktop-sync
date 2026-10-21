; Register only this fork's handler. Keep the original app's ProgIDs intact.
!define SYNC_CLASS "drawio-desktop-sync.drawio"
!define SYNC_KEY "Software\drawio-desktop-sync"

!macro customInit
  !insertmacro setInstallModePerUser
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ReadRegStr $0 HKCU "Software\Classes\.drawio" ""
  ${If} $0 != "${SYNC_CLASS}"
    WriteRegStr HKCU "${SYNC_KEY}\Installer" "PreviousDrawioClass" "$0"
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\.drawio" "" "${SYNC_CLASS}"
  WriteRegNone HKCU "Software\Classes\.drawio\OpenWithProgids" "${SYNC_CLASS}"
  WriteRegStr HKCU "Software\Classes\${SYNC_CLASS}" "" "drawio-desktop-sync Diagram"
  WriteRegStr HKCU "Software\Classes\${SYNC_CLASS}\DefaultIcon" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\${SYNC_CLASS}\shell\open" "" "Open with drawio-desktop-sync"
  WriteRegStr HKCU "Software\Classes\${SYNC_CLASS}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'

  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "drawio-desktop-sync"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".drawio" ""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  WriteRegStr HKCU "${SYNC_KEY}\Capabilities" "ApplicationName" "drawio-desktop-sync"
  WriteRegStr HKCU "${SYNC_KEY}\Capabilities" "ApplicationDescription" "Edit draw.io diagrams with server collaboration and AutoSave"
  WriteRegStr HKCU "${SYNC_KEY}\Capabilities" "ApplicationIcon" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "${SYNC_KEY}\Capabilities\FileAssociations" ".drawio" "${SYNC_CLASS}"
  WriteRegStr HKCU "Software\RegisteredApplications" "drawio-desktop-sync" "${SYNC_KEY}\Capabilities"

  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.drawio\shell\drawio-desktop-sync" "" "Open with drawio-desktop-sync"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.drawio\shell\drawio-desktop-sync" "Icon" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.drawio\shell\drawio-desktop-sync\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\.drawio" ""
  ${If} $0 == "${SYNC_CLASS}"
    ReadRegStr $0 HKCU "${SYNC_KEY}\Installer" "PreviousDrawioClass"
    ${If} $0 == ""
      DeleteRegValue HKCU "Software\Classes\.drawio" ""
    ${Else}
      WriteRegStr HKCU "Software\Classes\.drawio" "" "$0"
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.drawio\OpenWithProgids" "${SYNC_CLASS}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.drawio\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.drawio"
  DeleteRegKey HKCU "Software\Classes\${SYNC_CLASS}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.drawio\shell\drawio-desktop-sync"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "drawio-desktop-sync"
  DeleteRegKey HKCU "${SYNC_KEY}"
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TEXT "drawio-desktop-sync is installed. If Windows still uses another app for .drawio files, choose drawio-desktop-sync on the Default apps page. Your maps can then open directly from Explorer."
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Choose drawio-desktop-sync for .drawio files"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenSyncDefaults
  !insertmacro MUI_PAGE_FINISH
  Function OpenSyncDefaults
    ExecShell "open" "ms-settings:defaultapps?registeredAppUser=drawio-desktop-sync"
  FunctionEnd
!macroend
