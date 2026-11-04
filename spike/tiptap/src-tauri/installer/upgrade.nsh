!define NEVIS_LEGACY_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\Noviq"

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2

  ReadRegStr $0 HKCU "${NEVIS_LEGACY_UNINSTALL}" "InstallLocation"
  ReadRegStr $1 HKCU "${NEVIS_LEGACY_UNINSTALL}" "UninstallString"
  StrCpy $2 $0 1
  ${If} $2 == '$\"'
    StrCpy $0 $0 -1 1
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
  ${AndIf} $1 == '$\"$0\uninstall.exe$\"'
  ${AndIf} ${FileExists} "$0\noviq.exe"
  ${AndIf} ${FileExists} "$0\uninstall.exe"
    ; Wait for the old NSIS uninstaller and let it remove its own registration.
    ; Silent uninstall preserves the old data directory for first-launch migration.
    ExecWait '$\"$0\uninstall.exe$\" /S _?=$0' $2
    ${If} $2 == 0
    ${AndIfNot} ${FileExists} "$0\noviq.exe"
      Delete "$0\uninstall.exe"
      RMDir "$0"
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend
