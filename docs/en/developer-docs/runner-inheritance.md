# Project and Session Runner inheritance

A Project provides default settings for a Session. It is not a permission ceiling for
the machines that a Session can select.

## Three responsibility levels

- **System settings** maintain the global machine catalog, connection methods,
  credentials, and availability. The **Scientific environments** page manages Python/R
  environments and remote workspaces by Runner.
- **Project settings** select default remote Runners. Sessions without an override follow
  these defaults, including later changes.
- **Session settings** can inherit the Project or select independently from the global
  catalog of available machines. The same machine need not first be selected in the
  Project.

The local Runner is always available. A remote list only makes a machine a candidate.
Commands from the main Agent and Subagents still run against the Runner ID selected for
this run, and files are still synchronized explicitly.

## Exact behavior

| Session `remoteRunnerHostIds` | Effective rule |
| --- | --- |
| Unset | Dynamically inherit `Project.remoteRunnerHostIds` |
| Non-empty array | Completely replace the default; do not intersect it with the Project |
| Empty array `[]` | Explicitly use no remote Runner; do not fall back to the Project |
| Update request passes `null` | Clear the override and restore dynamic inheritance |
| Update request omits the field | Keep the existing selection |

For example, if the Project default is only A, a Session can independently select B or
A+B. Removing A from the Project later does not affect an overridden Session. It affects
only Sessions that remain in inheritance mode. An empty Project default likewise does
not prevent a Session from independently selecting B.

## Validation and security boundary

An independent selection does not bypass validation. A host must be registered in the
global catalog and have currently supported execution capability. Unknown or unavailable
machines cannot be newly selected. Actual execution and prompt directories use only the
Session's effective candidates, filtering machines that are currently unavailable. Do
not apply a second intersection with the Project list or use it to filter Session
options.

A global machine referenced by a Project or Session cannot be deleted directly; remove
the corresponding selection first. Saving passwords, host-key trust, Runner sandboxes,
and workspace boundaries do not change because of the inheritance rule.

## Saving from settings pages

The final save button for Project/Session runtime settings appears after all settings
sections. Remote Runner checkboxes and inheritance switches continue to save immediately
and are labelled as such. Draft changes for models, connectors, Skills, and similar
settings are submitted by the button at the bottom. Closing the dialog does not roll
back an immediately saved item.

## Runtime environments and workspace management

Whenever the control plane connects to a remote Runner or prepares its remote environment,
including the first deployment and later reconnections, it both ensures the Runner binary
is present and places a pinned micromamba version, verified by SHA-256, at
`<data-dir>/scientific-envs/bin/micromamba` on that machine. This supports isolated
compute machines, which commonly cannot reach release sites while the control plane that
deploys them can. If the machine already has the same pinned version, it reads and
verifies the checksum once without transfer. If the control plane cannot obtain the
release artifact itself, it does not block the connection. The Runner's environment
initialization state explains what is missing and whether a mirror
(`SCIENCE_AGENT_MICROMAMBA_BASE_URL`) or local path
(`SCIENCE_AGENT_PROVISIONER_PATH`) can resolve it.

Remote-machine clocks often differ from this installation, especially on private networks
where machines may not reach an NTP source. A Runner accepts execution signatures only
when their timestamps are within 30 seconds of its own clock. At connection time, the
control plane measures the fixed offset from the Runner response and writes signatures
using that Runner's clock. An offset over 30 seconds is shown on the machine card as a
reminder to configure NTP. The machine's own logs and file timestamps remain offset.

Records, in contrast, always use this installation's clock. At the client boundary,
execution start/end times reported by the Runner are converted back with the same offset.
This retains the Runner's measured duration without allowing a machine clock to disrupt
the timeline.

In **System settings** → **Scientific environments**, first select a Runner, then open
Python/R environments or Workspaces. Remote operations go through the main API to the
selected Runner. SSH remains tunneled, self-managed deployments use their configured
endpoint, and a disconnected machine does not fall back to local execution. Package-source
preferences remain global; remote environments and revisions are not merged into a local
directory with the same name.

Remote workspaces show the locations known to this application and their synchronization
history for each Project/Session, including archived Sessions and historical usage after a
machine is deselected. A location may be empty or not yet created; this is not a scan of
all directories on the remote machine. Deletion removes the displayed Session directory,
including Subagent subdirectories, from that Runner. It does not remove local files,
Artifacts, or history. Deletion requires confirmation and is rejected during an active
run. The model still initiates file transfer explicitly.

Session settings retain only execution selection and inheritance, not remote-workspace
cleanup controls.

## Regression entry points

- `services/api/src/store.test.ts`: independent machine selection, default changes,
  clearing/restoring inheritance, unknown/unavailable-machine validation, and reload.
- `services/api/src/remote-runner.test.ts`: when the Project default is empty, main-Agent
  and Subagent workspace operations remain authorized by the Session selection.
- `test/journey-ssh-remote-runner.spec.ts`: independent Session selection, bottom save,
  and global per-Runner management of environments and workspaces.
