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
  ; ---------------------------------------------------------------------------
  ; SIZEOPT W6 / design D11 S1' — shorten the default install root
  ; (owner decision, 2026-11-04).
  ;
  ; electron-builder's default per-user root is %LOCALAPPDATA%\Programs\<productName>
  ; (verified: app-builder-lib templates/nsis/multiUser.nsh:21-47, macro
  ;   setInstallModePerUser → StrCpy $0 "$LocalAppData\Programs").
  ; With the payload's measured maxRel=192 (assemble-backend A5) that root is
  ; 69 chars at a 20-char username → maxAbs = 69+1+192 = 262 > 259, i.e. it
  ; BREACHES MAX_PATH for any long username (problems W6). Dropping the
  ; intermediate "Programs" level is what buys the margin back.
  ;
  ; The root name carries an "App" suffix on purpose (problems W16). The bare
  ; %LOCALAPPDATA%\ScienceDiscovery is ALREADY the default data directory
  ; (wizard-data-dir.ts:22 defaultDataDir), and the uninstall tail deletes
  ; $INSTDIR unconditionally (customUnInstall below) — a user who accepted the
  ; wizard default would have had dataDir == $INSTDIR, so uninstalling without
  ; ticking "also delete user data" would still have taken envs/, secrets/
  ; (model keys) and every session with it, contradicting the promise this
  ; file makes at MUI_UNWELCOMEPAGE_TEXT. Measured budget for the two names:
  ;   ScienceDiscovery      rootLen 60  maxAbs 253  margin 6  == dataDir  ← W16
  ;   ScienceDiscoveryApp   rootLen 63  maxAbs 256  margin 3  distinct    ← this
  ; (node:path, maxRel=192 from A5, 20-char username = the Windows cap;
  ;  SD_INSTALL_ROOT_MAX=66 below; assemble-backend DEFAULT_ROOT_LEN must stay
  ;  in step with this rootLen.)
  ;
  ; The name must CONTAIN "ScienceDiscovery": assistedInstaller.nsh:33-38
  ; (instFilesPre) appends "\<APP_FILENAME>" whenever $INSTDIR does not
  ; already contain it, so a short name like "SD" would be re-expanded to
  ; SD\ScienceDiscovery and the budget above would be measuring the wrong
  ; string.
  ;
  ; Why not C:\ProgramData (owner proposed it): measured ACLs are
  ;   C:\ProgramData           BUILTIN\Users:(CI)(WD,AD,WEA,WA)  ← create only
  ;     └ <new subdir>          <creator>:(I)(F)                  ← creator owner full
  ;                             BUILTIN\Users:(I)(OI)(CI)(RX)     ← other users read+exec
  ; This product MUST write inside the install directory at runtime
  ; (CreateDirectory "$INSTDIR\logs" below this macro, main.ts:64 shell.log into
  ; <install>\logs, bootstrap.ts:407 fixVenvHome rewriting the payload's
  ; pyvenv.cfg) → after user A installs, user B logging in is functionally
  ; broken for lack of write permission. A per-user root is one copy per user
  ; with the creator as owner, so the problem does not arise.
  ;
  ; Reinstall does not migrate — and this is the part that has to be true in
  ; the code, not only in the comment (problems W17).
  ;
  ; Read the key electron-builder WRITES. InstallLocation is written exactly
  ; once in app-builder-lib 26.15.3, at templates/nsis/include/installer.nsh:104,
  ; and it goes to ${INSTALL_REGISTRY_KEY}; ${UNINSTALL_REGISTRY_KEY} carries
  ; DisplayName / UninstallString / DisplayVersion / DisplayIcon / Publisher and
  ; never InstallLocation (same file, :119-153). Reading the uninstall key
  ; therefore always yielded "", the ${If} always took the fallback, and every
  ; upgrade silently moved the user to the new default root — the opposite of
  ; what the comment above it claimed. multiUser.nsh:26 reads the install key
  ; too, which is the tell.
  ;
  ; Two guards, because "no prior install" is not the same as "the user did not
  ; pick a directory". initMultiUser runs first (installer.nsi:77, before
  ; customInit at :79-80) and leaves one of three things in $INSTDIR:
  ;   a. an existing InstallLocation from HKCU          → keep it (upgrade)
  ;   b. a /D= target, applied last at multiUser.nsh:50-54 → keep it (silent
  ;      install / enterprise deployment; /D= is NOT written to the registry,
  ;      so guard (a) alone still clobbers it)
  ;   c. the electron-builder default, whose "Programs" level is what breaches
  ;      MAX_PATH → this is the only case the override exists for.
  ;
  ; Register: $R3. customInit already uses $0-$9 and $R0/$R1/$R2/$R4/$R5/$R9.
  ; $R8/$R9 are additionally unusable as GetDParameter's outVar: that macro
  ; writes the result and only THEN pops its five saved registers back over it
  ; (multiUser.nsh:105-137), so an outVar of $R9 is overwritten by its own
  ; cleanup. GetDParameter is safe to insert here because initMultiUser already
  ; inserts it two lines earlier in this same .onInit.
  ReadRegStr $R3 SHCTX "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R3 == ""
    !insertmacro GetDParameter $R3
    ${If} $R3 == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\ScienceDiscoveryApp"
      DetailPrint "install root: no prior install and no /D= — using $INSTDIR"
    ${Else}
      DetailPrint "install root: keeping $INSTDIR from the /D= switch"
    ${EndIf}
  ${Else}
    DetailPrint "install root: keeping $INSTDIR from the previous install ($R3)"
  ${EndIf}

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
  ;     default location; a user who changes the folder in the wizard
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

; -----------------------------------------------------------------------------
; SIZEOPT W9 / D11 S4' — install-directory length guard (owner request, 2026-11-04).
;
; The gap: the data-dir wizard already had length gates (wizard-data-dir.ts
; warns at 180, blocks at 240) while the INSTALL directory had none — two
; standards inside one product. allowToChangeInstallationDirectory:true lets a
; user pick an arbitrarily deep directory, and the payload's deepest relative
; path is fixed, so every extra root character eats MAX_PATH headroom.
;
; Budget (problems W6): maxAbs = rootLen + 1 + maxRel, must be <= 259
;   maxRel = 192 ← MEASURED by assemble-backend.mjs's A5 gate (backend\jw layout)
;   → max rootLen = 259 - 1 - 192 = **66**
; ⚠️ 192 is a build-time constant: change the payload layout → maxRel moves →
;    this value must move with it. A5 prints maxRel on every build precisely so
;    that coupling stays visible (that is the point of the W9 guard).
;
; ⚠️⚠️ This value was first written as 70 (derived from a PREDICTED maxRel=188).
;    The first real A5 build measured **192**, so 70 was 4 chars too loose and
;    would let roots 67..70 pass the guard while actually breaching. The 4 chars
;    came from `check_method_figure_spec.cpython-312.pyc`(40) versus the
;    `render_method_figure.cpython-312.pyc`(36) the prediction was based on: the
;    W6 installed-tree walk CANNOT see the former, because under the old layout
;    its absolute path was 34+1+228 = **263 > 259**, so NSIS never wrote it during
;    extraction (measured: that __pycache__ holds 6 .pyc in the installed tree
;    versus 7 in the payload). So "margin 0" was an illusion — files were already
;    silently not installing. Lesson: **maxRel may only come from the build-time
;    A5 measurement, never be back-derived from an installed tree** (the tree is
;    truncated by MAX_PATH itself and thus self-conceals the breach).
;    See problems W15 / lessons L46.
;
; Why not hook MUI_PAGE_DIRECTORY's leave: electron-builder's
; assistedInstaller.nsh:28 states outright "pageDirectory leave doesn't work"
; ($INSTDIR only gets the product name appended AFTER leave). So this uses
; customPageAfterChangeDir — the location the template's own comment designates
; ("after change installation directory and before install start, you can show
; custom page here").
;
; ⚠️ But when customPageAfterChangeDir shows, $INSTDIR does NOT yet carry the
;    product name: that happens in the INSTFILES page pre callback
;    (assistedInstaller.nsh:32 instFilesPre, StrCpy $INSTDIR
;    "$INSTDIR\${APP_FILENAME}"), later than this page. So the length check here
;    must REPLICATE that append decision before measuring, otherwise it
;    systematically under-counts 1+16 = 17 chars and a 66 threshold effectively
;    becomes 83 — a guard in name only.
;
; ⚠️ The Function must be defined INSIDE the macro body: StrContains.nsh is
;    included by assistedInstaller.nsh only within its
;    `!ifdef allowToChangeInstallationDirectory` branch, and electron-builder
;    injects this file BEFORE the templates, so a top-level Function would
;    compile while ${StrContains} does not exist yet. Inside a macro it expands
;    at the insertmacro point (already within assistedInstaller.nsh).
;
; Why "warn + allow to continue" rather than a hard block: legitimate edges exist
; where the default root itself exceeds the limit (enterprise group policy
; redirecting FOLDERID_UserProgramFiles somewhere deep). A hard block would trap
; such users inside the installer with nowhere to go; offering an "install
; anyway" exit means the worst case is a first-run ImportError that
; <install>\logs\shell.log pinpoints — recoverable, which beats not installing.
;
; ⚠️⚠️ "No" means CANCEL, not "go back and re-pick". These two guards live in a
;    custom page's CREATOR function, and there Abort means "skip this page":
;    the wizard then advances to InstFiles and installs into the very root the
;    user just rejected. The first version did exactly that while its MessageBox
;    said 「选「否」可返回重选目录」 and its DetailPrint said "returning to the
;    directory page" — a guard in name only, reported by agent-ci-infra-bot F9
;    against eb99ee2e. There is no documented way to jump backwards from a
;    custom page creator (electron-builder's own comment at
;    assistedInstaller.nsh:28 says pageDirectory's leave "doesn't work", which is
;    why it moved this logic to a page at all), so Quit is used: it is the only
;    outcome whose semantics cannot be misread. Users who decline re-run the
;    installer and pick a shorter directory; the MessageBox text says so.
!define SD_INSTALL_ROOT_MAX 66

!macro customPageAfterChangeDir
  Page custom SdCheckInstallDirLength ""

  Function SdCheckInstallDirLength
    ; Replicate instFilesPre's append: when $INSTDIR lacks the product name it
    ; will get "\<APP_FILENAME>" appended later, so count it now.
    StrLen $0 $INSTDIR
    ${StrContains} $1 "${APP_FILENAME}" $INSTDIR
    ${If} $1 == ""
      IntOp $0 $0 + 1              ; backslash
      StrLen $1 "${APP_FILENAME}"
      IntOp $0 $0 + $1             ; product name
    ${EndIf}

    ${If} $0 > ${SD_INSTALL_ROOT_MAX}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "安装目录过长，可能导致安装后无法启动。$\r$\n$\r$\n当前目录：$\r$\n$INSTDIR$\r$\n（最终路径 $0 个字符，上限 ${SD_INSTALL_ROOT_MAX}）$\r$\n$\r$\n本程序的环境文件路径很深，Windows 有 260 字符路径上限；目录每多一个字符，留给内部文件的余量就少一个。$\r$\n$\r$\n建议改到更短的路径，例如：$\r$\n  C:\SD$\r$\n$\r$\n仍要安装到当前目录吗？$\r$\n（选「否」将取消本次安装，请重新运行安装程序并选择较短的目录）" \
        IDYES sd_len_proceed
      ; "No" cancels the install outright. It does NOT go back to the directory
      ; page: this runs in a custom page's CREATOR function, where Abort means
      ; "skip this page" and the wizard advances to InstFiles — so the first
      ; version of this guard let "No" install into the over-long root anyway
      ; while its own log line claimed otherwise (agent-ci-infra-bot F9).
      ; Quit is the only unambiguous "do not install" available here.
      DetailPrint "install-dir length guard: $0 chars exceeds ${SD_INSTALL_ROOT_MAX}, user declined — cancelling the install"
      ; SetErrorLevel BEFORE Quit: a bare Quit in a page creator exits 0.
      ; Measured on this machine (NSIS 3.0.4.1 from the electron-builder cache,
      ; logs/f11/probe2.nsi + probe3.nsi, marker file proves Quit took effect
      ; and the section never ran):
      ;   .onInit, bare Quit            -> 2
      ;   page creator, bare Quit       -> 0   <- where these guards live
      ;   page creator, SetErrorLevel 1 -> 1
      ; Page POSITION does not change it (a quitting creator on the first page
      ; and one on the second both give 0). So without this line an unattended
      ; run that declined would report SUCCESS to its caller, the same lie the
      ; Abort version told the user (agent-ci-infra-bot F9), aimed at automation
      ; instead (F11). 1 matches the Cancel button's own code.
      ; Note this does NOT contradict app-builder-lib's common.nsh:78-82
      ; (`# avoid exit code 2` + SetErrorLevel 0 + Quit): that macro runs on the
      ; success path, and exit 2 is what a bare Quit gives from .onInit, not
      ; from a page creator.
      SetErrorLevel 1
      Quit
      sd_len_proceed:
      DetailPrint "install-dir length guard: user accepted $0 chars (limit ${SD_INSTALL_ROOT_MAX})"
    ${Else}
      DetailPrint "install-dir length guard: $0 chars OK (limit ${SD_INSTALL_ROOT_MAX})"
    ${EndIf}
    ; --- install-dir / data-dir collision guard (problems W16) --------------
    ; The uninstall tail deletes $INSTDIR unconditionally (customUnInstall →
    ; DeleteFastThenHelper "$INSTDIR"), so an install dir that IS the data dir,
    ; or sits inside it, would take envs/, secrets/ (model keys) and every
    ; session with it on uninstall — even with "also delete user data" left
    ; unticked, contradicting MUI_UNWELCOMEPAGE_TEXT above. customInit now
    ; defaults the root to \ScienceDiscoveryApp (disjoint from the
    ; \ScienceDiscovery data dir), but allowToChangeInstallationDirectory lets a
    ; user point it back at the data dir; warn before that installs. The
    ; first-run wizard re-checks the same rule at runtime (wizard-data-dir.ts
    ; installRootCollision) — this is the earlier, install-time half.
    ;
    ; The data dir is read from the shell's mirror file first and only falls
    ; back to the default, exactly as customUnInstall does below: on a fresh
    ; install data-dir.txt does not exist yet (the wizard runs afterwards), so
    ; the default applies; on a reinstall/upgrade it carries the user's real
    ; choice, which is precisely the case where their data already sits there.
    ; Registers $2-$8: free here. This is a page callback, the length guard
    ; above already uses $0/$1, and every later reader of $1-$9 (customInstall's
    ; GetTime, customUnInstall's $R* scan) assigns before use.
    StrCpy $4 "$LOCALAPPDATA\ScienceDiscovery"
    IfFileExists "$APPDATA\sd-shell\data-dir.txt" 0 sd_col_data_ready
    ClearErrors
    FileOpen $3 "$APPDATA\sd-shell\data-dir.txt" r
    ${IfNot} ${Errors}
      FileRead $3 $6
      FileClose $3
      sd_col_trim:
        StrLen $7 $6
        IntCmp $7 0 sd_col_trim_done
        StrCpy $8 $6 1 -1
        StrCmp $8 "$\r" sd_col_chop 0
        StrCmp $8 "$\n" sd_col_chop 0
        Goto sd_col_trim_done
      sd_col_chop:
        IntOp $7 $7 - 1
        StrCpy $6 $6 $7
        Goto sd_col_trim
      sd_col_trim_done:
      ${If} $6 != ""
        StrCpy $4 $6
      ${EndIf}
    ${EndIf}
    sd_col_data_ready:

    ; Compare the FINAL root: $INSTDIR here still lacks the \${APP_FILENAME}
    ; that instFilesPre appends later (assistedInstaller.nsh:32-38), so
    ; replicate that append exactly as the length guard above does. A user who
    ; picks the data dir's PARENT ($LOCALAPPDATA) therefore resolves to
    ; $LOCALAPPDATA\ScienceDiscovery and is caught as "same", not missed.
    StrCpy $2 $INSTDIR
    ${StrContains} $3 "${APP_FILENAME}" $INSTDIR
    ${If} $3 == ""
      StrCpy $2 "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    StrCpy $5 ""                                  ; verdict: "" | same | inside
    ${If} $2 == $4
      StrCpy $5 "same"
    ${Else}
      ; Is the final install root ($2) a descendant of the data dir ($4)?
      ; Prefix match PLUS a separator at the boundary, so \ScienceDiscoveryApp
      ; is not "inside" \ScienceDiscovery (the char after the shared prefix is
      ; "A", not a backslash) — the same separator rule the TS gate uses.
      ; StrCmp/== is case-insensitive in NSIS, matching Windows path semantics.
      StrLen $6 $4
      StrCpy $7 $2 $6
      ${If} $7 == $4
        StrCpy $8 $2 1 $6
        ${If} $8 == '\'
          StrCpy $5 "inside"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $5 != ""
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "安装目录与数据目录重合：卸载时会连同运行环境、密钥与会话数据一并删除。$\r$\n$\r$\n安装目录：$\r$\n$2$\r$\n数据目录：$\r$\n$4$\r$\n$\r$\n建议改用其它安装目录（例如 C:\SD）。$\r$\n$\r$\n仍要安装到当前目录吗？$\r$\n（选「否」将取消本次安装，请重新运行安装程序并选择其它目录）" \
        IDYES sd_col_proceed
      DetailPrint "install-dir collision guard: root is $5 the data dir — user declined, cancelling the install"
      ; Same reason as the length guard above: bare Quit exits 0 from a page
      ; creator, so a declined run would look like a successful install to any
      ; caller that scripted it (agent-ci-infra-bot F11). Measured, not assumed.
      SetErrorLevel 1
      Quit
      sd_col_proceed:
      DetailPrint "install-dir collision guard: user accepted a root $5 the data dir"
    ${Else}
      DetailPrint "install-dir collision guard: root is clear of the data dir ($4)"
    ${EndIf}
  FunctionEnd
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
; fall back to the PowerShell long-path helper, then robocopy. The helper and
; the robocopy mirror source are staged inside $PLUGINSDIR — the uninstaller's
; own unpredictable temp directory — so a same-user process cannot pre-plant
; either one in the shared %TEMP% root.
!macro DeleteFastThenHelper target
  nsExec::ExecToLog 'cmd /c rd /s /q "${target}"'
  Pop $R0
  ${If} $R0 != 0
    ${If} ${FileExists} "$PLUGINSDIR\sd-uninstall-helper.ps1"
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\sd-uninstall-helper.ps1" "${target}"'
    ${Else}
      CreateDirectory "$PLUGINSDIR\sd-clean-empty"
      nsExec::ExecToLog 'robocopy "$PLUGINSDIR\sd-clean-empty" "${target}" /MIR /NFL /NDL /NJH /NJS /NP'
      RMDir /r "${target}"
      RMDir "$PLUGINSDIR\sd-clean-empty"
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
    ; Stage the helper in the uninstaller's $PLUGINSDIR (an unpredictable
    ; per-run temp directory) before the install dir — and any helper file
    ; inside it — is deleted.
    ${If} ${FileExists} "$INSTDIR\resources\uninstall_helper.ps1"
      CopyFiles "$INSTDIR\resources\uninstall_helper.ps1" "$PLUGINSDIR\sd-uninstall-helper.ps1"
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
