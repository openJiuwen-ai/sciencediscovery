; Minimal makensis stub for syntax-checking win_desktop/build/installer.nsh
; without a 20-minute electron-builder package run (the file's own header,
; :31-33, asks for exactly this).
;
; Defines mirror what app-builder-lib's NsisTarget.js passes for this app:
;   APP_FILENAME   = getWindowsInstallationDirName(appInfo, !oneClick || isPerMachine)
;                  → oneClick:false, so the productName branch: "ScienceDiscovery"
;                  (targetUtil.js:40-41; productFilename passes /^[-_+0-9a-zA-Z .]+$/)
;   PRODUCT_FILENAME = appInfo.productFilename = "ScienceDiscovery"
;   APP_GUID       = UUID.v5(appId, ELECTRON_BUILDER_NS_UUID) → any stable GUID
;   UNINSTALL_APP_KEY = the GUID with backslashes → " - "
; INSTALL_REGISTRY_KEY / UNINSTALL_REGISTRY_KEY come from multiUser.nsh:8-9
; (!define /ifndef) once APP_GUID and UNINSTALL_APP_KEY exist.
;
; Why the ABSOLUTE includes below: NSIS resolves !include against the script's
; own directory first and only then the include dirs, and Windows is
; case-insensitive — so a bare `!include "multiUser.nsh"` from this stub picks
; up NSIS's built-in Include\MultiUser.nsh instead of app-builder-lib's
; templates/nsis/multiUser.nsh, and the build then fails on GetDParameter and
; INSTALL_REGISTRY_KEY, neither of which the built-in file defines. The real
; electron-builder run does not hit this because it copies the templates next to
; the generated installer.nsi, so the script-dir lookup finds the right file.
;
; Run from win_desktop/ (SD_NSI_OUT is REQUIRED — see the note below):
;   makensis -INPUTCHARSET UTF8 \
;     -DSD_NSI_TEMPLATES="<abs>\app-builder-lib\templates\nsis" \
;     -DSD_NSI_PLUGINS="<abs>\nsis-resources-3.4.1\plugins\x86-unicode" \
;     -DSD_NSI_OUT="<abs>\throwaway.exe" \
;     build/nsh-syntax-check-stub.nsi
; Both paths come from the electron-builder cache; see
; scripts/nsh-syntax-check.mjs, which discovers and passes them.

!ifndef SD_NSI_TEMPLATES
  !error "pass -DSD_NSI_TEMPLATES=<abs path to app-builder-lib/templates/nsis>"
!endif
!ifndef SD_NSI_PLUGINS
  !error "pass -DSD_NSI_PLUGINS=<abs path to nsis-resources plugins/x86-unicode> (StdUtils.dll)"
!endif
; The compile output is throwaway. SD_NSI_OUT must be an ABSOLUTE literal: NSIS
; does not expand its own $TEMP/$EXEPATH inside a !define'd string the way it
; does in instructions, so `OutFile "$TEMP\x.exe"` became <script dir>\$TEMP\...
; and the compile died on "Can't open output file" — AFTER printing all six
; warnings, so a script that only read the warnings would have called it a pass.
; scripts/nsh-syntax-check.mjs always passes it and asserts on the exit code.
!ifndef SD_NSI_OUT
  !error "pass -DSD_NSI_OUT=<absolute path>; or run: node scripts/nsh-syntax-check.mjs"
!endif

Unicode true
; StdUtils.dll (used by multiUser.nsh's GetDParameter) and the app-builder-lib
; headers such as UAC.nsh. Two ordering rules, both learned by failing compile:
;   - these MUST come after `Unicode true`: switching Unicode re-resolves plugin
;     dirs against each dir's x86-unicode subdir, and an !addplugindir issued
;     beforehand is dropped;
;   - NSIS 3.0 requires the architecture target (/x86-unicode) and a path to the
;     arch SUBDIR. Without it the directive errors out ("Target parameter must
;     be one of: /x86-ansi, /x86-unicode, ...") and the plugin is never found,
;     which surfaces as "Plugin not found, cannot call
;     StdUtils::GetAllParameters" from inside GetDParameter.
!addplugindir /x86-unicode "${SD_NSI_PLUGINS}"
!addincludedir "${SD_NSI_TEMPLATES}"
!addincludedir "${SD_NSI_TEMPLATES}\include"

SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "installer.nsh syntax check"
OutFile "${SD_NSI_OUT}"
InstallDir "$LOCALAPPDATA\Programs"

!define APP_GUID "c4c5a1a2-6a4e-5b8f-9c3d-0e1f2a3b4c5d"
!define UNINSTALL_APP_KEY "c4c5a1a2-6a4e-5b8f-9c3d-0e1f2a3b4c5d"
!define APP_FILENAME "ScienceDiscovery"
!define PRODUCT_FILENAME "ScienceDiscovery"
!define PRODUCT_NAME "ScienceDiscovery"
!define VERSION "0.4.0.rc1"
!define APP_PACKAGE_NAME "sd-shell"
!define SHORTCUT_NAME "ScienceDiscovery"
!define MENU_FILENAME "ScienceDiscovery"
!define APP_ID "cn.sciencediscovery.desktop"
!define PROJECT_DIR "."
!define BUILD_RESOURCES_DIR "build"
; electron-builder sets this for nsis.allowToChangeInstallationDirectory:true,
; which is what makes assistedInstaller.nsh:23 include StrContains.nsh and :42
; expand customPageAfterChangeDir — the two things installer.nsh depends on.
!define allowToChangeInstallationDirectory

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "${SD_NSI_TEMPLATES}\multiUser.nsh"
!include "${SD_NSI_TEMPLATES}\include\StdUtils.nsh"
!include "${SD_NSI_TEMPLATES}\include\StrContains.nsh"

!insertmacro MUI_LANGUAGE "SimpChinese"

; The file under test — next to this stub, so the script-dir lookup finds it.
!include "installer.nsh"

; Page directives must precede any Section, so expand the page macro here (it
; also defines its callback Function).
!insertmacro customPageAfterChangeDir

Function .onInit
  !insertmacro customInit
FunctionEnd

Section "install"
  SetOutPath $INSTDIR
  !insertmacro customInstall
SectionEnd

Section "un.install"
  !insertmacro customUnInstall
SectionEnd
