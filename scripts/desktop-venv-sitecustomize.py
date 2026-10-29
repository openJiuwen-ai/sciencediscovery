# Desktop payload sitecustomize — injected by assemble-backend.mjs
# into the bundled JiuwenSwarm venv's site-packages.
#
# Why: the Electron shell spawns the whole stack with hidden consoles
# (windowsHide / CREATE_NO_WINDOW). Python console-subsystem children spawned
# from such a console-less parent each allocate their OWN visible console
# window unless CREATE_NO_WINDOW is passed. The jw tree has dozens of
# subprocess.Popen/run sites (tool execution, diff, git, MCP drivers, status
# probes…) — patching them one by one in this vendored tree is unmaintainable,
# so patch the single choke point every one of them routes through:
# subprocess.Popen.
#
# Activation is gated on SCIENCE_AGENT_DESKTOP=1, which start-stack.mjs sets
# for the packaged desktop stack. Dev terminals (parent HAS a console) never
# see this patch, so interactive dev workflows keep their console behavior.
# Callers that pass their own creationflags (e.g. upgrade_executor's
# DETACHED_PROCESS, debug_launcher) are left untouched — those flags already
# suppress the window.

import os

if os.name == "nt" and os.environ.get("SCIENCE_AGENT_DESKTOP") == "1":
    import subprocess

    _CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if _CREATE_NO_WINDOW:
        _orig_popen_init = subprocess.Popen.__init__

        def _popen_init_hidden(self, *args, **kwargs):
            # Respect explicit creationflags entirely (DETACHED_PROCESS and
            # CREATE_NO_WINDOW are mutually exclusive per CreateProcess docs).
            if not kwargs.get("creationflags"):
                kwargs["creationflags"] = _CREATE_NO_WINDOW
            return _orig_popen_init(self, *args, **kwargs)

        _popen_init_hidden.__name__ = "__init__"
        subprocess.Popen.__init__ = _popen_init_hidden
