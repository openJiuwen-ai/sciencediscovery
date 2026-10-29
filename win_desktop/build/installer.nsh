; Installer presentation: plain release form —
; stock welcome page (no MUI_WELCOMEPAGE_TEXT essay), stock InstFiles page
; (stock localized "installing" text), details view collapsed, no closing
; banner. The single visible progress run is the ② main extraction (0→100%,
; Nnis7z-driven — see patches/app-builder-lib@26.15.3.patch).
;
; Clean-uninstall options:
;   (a) uninstall-time dialog offers "also delete user data" — silent (/S)
;       uninstalls KEEP everything (/SD IDNO) so automation can never wipe it;
;   (b) the three data locations are removed long-path-safe (robocopy /MIR
;       from an empty dir) because NSIS RMDir cannot delete >260-char trees
;       (deep document trees once broke the uninstaller);
;   (c) desktop/start-menu shortcuts are always taken down (the stock
;       cleanup once left them behind);
;   (d) install time self-heals a ghost uninstall registry key (uninstaller
;       file missing) — electron-builder's built-in old-version handshake
;       once hung the installer for 15 minutes on exactly that;
;   (e) the shell mirrors the wizard's chosen data dir into
;       %APPDATA%\sd-shell\data-dir.txt (wizard-state.ts) so the uninstaller
;       can offer to remove custom locations. Keep "sd-shell" here in sync
;       with package.json name (Electron userData) and the
;       $LOCALAPPDATA\ScienceDiscovery fallback with the packaged default.
;
; NSIS constraint (learned the hard way, EB_EXIT=1): this file is included at
; the TOP LEVEL of the generated script — runtime instructions (ReadRegStr,
; MessageBox, DetailPrint) are only valid inside Section/Function, so ALL
; logic must live inside macros that electron-builder expands inside
; .onInit (customInit) or the install section (customInstall).
; customUnInstall is expanded inside the uninstall section.
;
; Syntax-check this file in seconds (not a 20-minute full package build):
;   wrap it in a minimal .nsi stub that !includes this file, then run
;   makensis /INPUTCHARSET UTF8 on that stub

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; MUI_WELCOMEPAGE_TEXT removed — the MUI2 language-file default welcome
; text is the release form.

; Custom uninstaller welcome
; text — kept even though the installer-side welcome essay is gone: it
; explains the "keep user data by default" semantics for the
; checkbox page that follows.
!define MUI_UNWELCOMEPAGE_TEXT "将从您的计算机移除 ScienceDiscovery。$\r$\n$\r$\n默认保留用户数据（界面设置、运行环境与密钥、智能体实例数据）；若在前一页勾选了「同时删除用户数据」，则会一并删除。$\r$\n$\r$\n单击 [下一步(N)] 继续。"

!macro preInit
  ; Keep SetDetailsView show — it changes the
  ; InstFiles page layout so the NSIS runtime does NOT re-inflate the
  ; zero-sized progress bar during File instructions; without it the bar
  ; leaks in phase ① (proven in the field). The details list is
  ; harmless because SetDetailsPrint listonly only emits phase headers, and
  ; those are kept collapsed.
  SetDetailsView show
!macroend

!macro customInit
  ; Update install over an existing one: electron-builder silently uninstalls
  ; the old copy first. A pre-removal announcement MessageBox
  ; existed here but was removed — in the field
  ; it caused more confusion than it solved (multiple installer instances /
  ; stacked dialogs led users to misread which build they were looking at).
  ; The welcome-page text + the unified progress bar + the per-phase window
  ; titles already carry the "this is an update, data is preserved" story.
  ; The registry read below stays: it feeds the install-diagnostics marker.
  ReadRegStr $0 SHCTX "${UNINSTALL_REGISTRY_KEY}" "UninstallString"

  ; Installer diagnostics — the first-run chain has
  ; startup-diagnostics.log; the installer had NOTHING (two field installs
  ; once stuck with no way to tell which phase died). "start" is written at
  ; .onInit and records whether the risky built-in old-version removal is
  ; about to run; "end" is written at the install-section tail. A stuck
  ; install self-reports its last completed phase.
  ;
  ; Install-time markers moved from
  ; %APPDATA%\sd-shell to $INSTDIR\logs — the same folder the shell writes
  ; shell.log into (main.ts shellLogDir), so one folder answers "where are the
  ; install logs". Known edges, accepted as-is:
  ;   - .onInit runs BEFORE the directory page, so $INSTDIR here is the
  ;     default (/D=) location; a user who changes the folder in the wizard
  ;     leaves the "start" line in the default location and the "end" line in
  ;     the final one (both still exist, just in two files).
  ;   - an update install runs the old uninstaller first, which deletes the
  ;     old $INSTDIR\logs — install diagnostics reset on every update.
  ; Uninstall-time markers (below) STAY in %APPDATA\sd-shell: the uninstall
  ; flow deletes $INSTDIR itself (customUnInstall sweep + the main section's
  ; fastRemoveDir), so a marker written there would not survive the very
  ; uninstall it is diagnosing.
  StrCpy $8 "no"
  ${If} $0 != ""
    StrCpy $8 "yes"
  ${EndIf}
  CreateDirectory "$INSTDIR\logs"
  ClearErrors
  FileOpen $9 "$INSTDIR\logs\install-diagnostics.log" a
  ${IfNot} ${Errors}
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    FileWrite $9 "[$3-$2-$1 $5:$6:$7] install start: old-install-present=$8$\r$\n"
    FileClose $9
  ${EndIf}

  ; Self-heal a ghost uninstall registry key. When the recorded
  ; uninstaller no longer exists on disk (install dir moved or wiped —
  ; seen in the field with a ghost D:\ProgramData install), drop the key so
  ; electron-builder's built-in old-version handshake cannot stall on it.
  ReadRegStr $R0 SHCTX "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R0 != ""
    ; Extract the uninstaller path: quoted form "C:\...\Uninstall.exe" /flags
    ; (stop at the closing quote), unquoted form stops at the first space.
    StrCpy $R1 ""
    StrCpy $R2 0
    StrCpy $R5 " "
    StrCpy $R4 $R0 1
    ${If} $R4 == '"'
      StrCpy $R2 1
      StrCpy $R5 '"'
    ${EndIf}
    scan_data_dir:
      StrCpy $R4 $R0 1 $R2
      StrCmp $R4 "" scan_done
      StrCmp $R4 $R5 scan_done
      StrCpy $R1 "$R1$R4"
      IntOp $R2 $R2 + 1
      Goto scan_data_dir
    scan_done:
    ${If} $R1 != ""
    ${AndIfNot} ${FileExists} "$R1"
      DeleteRegKey SHCTX "${UNINSTALL_REGISTRY_KEY}"
      DetailPrint "ghost uninstall registry key removed (uninstaller missing: $R1)"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; End marker — a log with "start" but no "end" means the install
  ; died between .onInit and the section tail (old-version removal,
  ; extraction, or staging move). The closing banner DetailPrint is
  ; gone (release form) — only the log write remains.
  ; Same $INSTDIR\logs as the start marker (see customInit).
  CreateDirectory "$INSTDIR\logs"
  ClearErrors
  FileOpen $9 "$INSTDIR\logs\install-diagnostics.log" a
  ${IfNot} ${Errors}
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    FileWrite $9 "[$3-$2-$1 $5:$6:$7] install section end: extraction+tail done$\r$\n"
    FileClose $9
  ${EndIf}
!macroend

; Fast-delete helper: try cmd `rd /s /q` first (avoids robocopy/PowerShell
; overhead for normal paths). If it fails (long paths, locked files, read-only),
; fall back to the PowerShell long-path helper, then robocopy.
!macro DeleteFastThenHelper target
  nsExec::ExecToLog 'cmd /c rd /s /q "${target}"'
  Pop $R0
  ${If} $R0 != 0
    ${If} ${FileExists} "$TEMP\sd-uninstall_helper.ps1"
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\sd-uninstall_helper.ps1" "${target}"'
    ${Else}
      CreateDirectory "$TEMP\sd-clean-empty"
      nsExec::ExecToLog 'robocopy "$TEMP\sd-clean-empty" "${target}" /MIR /NFL /NDL /NJH /NJS /NP'
      RMDir /r "${target}"
      RMDir "$TEMP\sd-clean-empty"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; Shortcuts always go — electron-builder's own cleanup once missed them
  ; (ghost installs from other locations had re-created them).
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_FILENAME}"

  ; Install-dir residue — runtime-written files with >260-char paths
  ; (deep document trees) survive NSIS's RMDir (nine ghost files seen in the
  ; field). Sweep
  ; the install dir with a PowerShell long-path helper so it goes
  ; completely (the running uninstaller exe stays locked; electron-builder's
  ; self-delete tail takes care of that one file).
  ${If} ${FileExists} "$INSTDIR"
    ; Stage the helper in %TEMP% before the install dir (and any helper file
    ; inside it) is deleted.
    ${If} ${FileExists} "$INSTDIR\resources\uninstall_helper.ps1"
      CopyFiles "$INSTDIR\resources\uninstall_helper.ps1" "$TEMP\sd-uninstall_helper.ps1"
    ${EndIf}
    !insertmacro DeleteFastThenHelper "$INSTDIR"
  ${EndIf}

  ; Resolve the user's data dir — the shell mirrors the wizard's
  ; choice into data-dir.txt (plain text; NSIS has no JSON). Fallback is the
  ; packaged default. Keep in sync with wizard-state.ts / bootstrap defaults.
  StrCpy $R5 "$LOCALAPPDATA\ScienceDiscovery"
  IfFileExists "$APPDATA\sd-shell\data-dir.txt" 0 data_ready
  ClearErrors
  FileOpen $R0 "$APPDATA\sd-shell\data-dir.txt" r
  ${IfNot} ${Errors}
    FileRead $R0 $R1
    FileClose $R0
    trim_loop:
      StrLen $R2 $R1
      IntCmp $R2 0 trim_done
      StrCpy $R3 $R1 1 -1
      StrCmp $R3 "$\r" chop_char 0
      StrCmp $R3 "$\n" chop_char 0
      Goto trim_done
    chop_char:
      IntOp $R2 $R2 - 1
      StrCpy $R1 $R1 $R2
      Goto trim_loop
    trim_done:
    ${If} $R1 != ""
      StrCpy $R5 $R1
    ${EndIf}
  ${EndIf}
  data_ready:

  ; Uninstall marker (dataDir recorded for the optional section).
  ; Stays in %APPDATA\sd-shell on purpose — the lines above and
  ; the main uninstall section both delete $INSTDIR, so a marker written into
  ; the install dir would not survive the uninstall it is diagnosing.
  ClearErrors
  FileOpen $9 "$APPDATA\sd-shell\install-diagnostics.log" a
  ${IfNot} ${Errors}
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    FileWrite $9 "[$3-$2-$1 $5:$6:$7] uninstall custom tail done: dataDir=$R5$\r$\n"
    FileClose $9
  ${EndIf}
!macroend

; The native uninstaller checkbox page (replaces an interim MessageBox
; prompt). electron-builder wires this macro into
; MUI_UNPAGE_COMPONENTS (installer.nsi L13-18) — the main uninstall section
; is SectionIn RO (cannot be unchecked), this one defaults to UNCHECKED (/o),
; so silent (/S) uninstalls skip it and keep user data, same semantics as the
; old /SD IDNO default. $R5 (data dir) was resolved in customUnInstall above.
!macro customUnInstallSection
  Section /o "un.同时删除用户数据（界面设置 / 运行环境与密钥 / 智能体实例数据）" SEC_DEL_USER_DATA
  ; Bracket the optional data deletion (checked only).
  ; The begin marker moved from %APPDATA\sd-shell (where it was
  ; written and then destroyed by this very section's RMDir two lines later —
  ; the begin line could never be read) to %TEMP\sd-data-delete.log, the same
  ; file the done marker below already uses. $INSTDIR is equally unusable
  ; here: the main uninstall section has already removed it.
  ClearErrors
  FileOpen $9 "$TEMP\sd-data-delete.log" a
  ${IfNot} ${Errors}
    ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
    FileWrite $9 "[$3-$2-$1 $5:$6:$7] user-data delete begin: sd-shell + $R5 + .jiuwenswarm-instances$\r$\n"
    FileClose $9
  ${EndIf}
    RMDir /r "$APPDATA\sd-shell"
    ${If} ${FileExists} "$APPDATA\sd-shell"
      !insertmacro DeleteFastThenHelper "$APPDATA\sd-shell"
    ${EndIf}
    RMDir /r "$R5"
    ${If} ${FileExists} "$R5"
      !insertmacro DeleteFastThenHelper "$R5"
    ${EndIf}
    RMDir /r "$PROFILE\.jiuwenswarm-instances"
    ${If} ${FileExists} "$PROFILE\.jiuwenswarm-instances"
      !insertmacro DeleteFastThenHelper "$PROFILE\.jiuwenswarm-instances"
    ${EndIf}
    ; Done marker — $APPDATA\sd-shell was just deleted by this very
    ; section, so this line lands in %TEMP% instead.
    ClearErrors
    FileOpen $9 "$TEMP\sd-data-delete.log" a
    ${IfNot} ${Errors}
      ${GetTime} "" "L" $1 $2 $3 $4 $5 $6 $7
      FileWrite $9 "[$3-$2-$1 $5:$6:$7] user-data delete done$\r$\n"
      FileClose $9
    ${EndIf}
  SectionEnd
!macroend
