// Pipeline for a self-hosted Jenkins worker whose kernel grants unprivileged
// user namespaces, so bubblewrap runs natively and the UT guest tier needs no
// QEMU guest. Every layer is the per-layer Docker command documented in
// .ci/README.md, running the repository's own pnpm ci:* entry points.
//
// Rules from .agents/skills/ci/SKILL.md that this file keeps:
//   * call the pnpm ci:* entry points; never build a second, platform-specific
//     test definition here
//   * never weaken a sandbox assertion to make the pipeline green
//   * no --privileged, and no Docker socket inside the test container
//
// Everything host-specific (cache directory, base image sources, proxies,
// timeouts) comes from Jenkins global environment variables, so no machine
// path or private mirror is written into the repository. With all of them
// unset the pipeline falls back to the image and Dockerfile defaults.

// These three options are what lets bubblewrap create a user namespace inside
// the container. Drop any one of them and the Runner tests report
// "bwrap: No permissions to create new namespace". They are the same
// non-privileged allowances the product's checked-in Compose file uses, not a
// stand-in for --privileged.
String sandboxOpts() {
    return '--security-opt seccomp=unconfined ' +
           '--security-opt apparmor=unconfined ' +
           '--security-opt systempaths=unconfined'
}

// The image's /etc/passwd only knows node(1000). When the checkout owner's uid
// is anything else, everything in the container that calls getpwuid() fails:
// the executor package shells out to ssh-keygen and reports
// "No user exists for uid <N>". Keep the image's own entries and append the
// caller, rather than replacing the file with the host's.
void prepareNss() {
    sh label: 'nss shim', script: '''
set -eu
mkdir -p "$CI_NSS_DIR"
docker run --rm "$CI_IMAGE" cat /etc/passwd > "$CI_NSS_DIR/passwd"
docker run --rm "$CI_IMAGE" cat /etc/group  > "$CI_NSS_DIR/group"
if ! grep -q ":x:$(id -u):" "$CI_NSS_DIR/passwd"; then
    echo "ci:x:$(id -u):$(id -g):ci:/ci-home:/bin/bash" >> "$CI_NSS_DIR/passwd"
fi
if ! grep -q ":x:$(id -g):" "$CI_NSS_DIR/group"; then
    echo "ci:x:$(id -g):" >> "$CI_NSS_DIR/group"
fi
'''
}

// One layer is one docker run. The mounts match "One command per layer" in
// .ci/README.md: the checkout at /src (never /workspace, which the Runner's
// sandbox mounts over), reports at /ci-results, dependency and browser caches
// at /ci-cache.
void ciLayer(String layer, String extraArgs = '') {
    sh label: "pnpm ci:${layer}", script: """
set -eu

# A bind source has to exist and belong to the caller first: Docker creates a
# missing one as root, and the non-root container then cannot write its reports.
mkdir -p "\$CI_RESULTS_HOST"

CACHE_ARG=""
if [ -n "\${CI_CACHE_DIR:-}" ]; then
    mkdir -p "\$CI_CACHE_DIR"
    CACHE_ARG="-v \$CI_CACHE_DIR:/ci-cache"
fi

# Only a proxy can speed dependency downloads up here; the index URL must stay
# as it is. uv.lock records the index, so setting UV_DEFAULT_INDEX makes
# uv sync --locked refuse with "The lockfile at uv.lock needs to be updated,
# but --locked was provided". A proxy leaves the URL, and the lock, valid.
# NO_PROXY has to cover loopback or the E2E stack's own health checks get
# proxied away.
ENV_ARGS=""
if [ -n "\${CI_RUN_PROXY:-}" ]; then
    ENV_ARGS="--env HTTP_PROXY=\$CI_RUN_PROXY --env HTTPS_PROXY=\$CI_RUN_PROXY"
    ENV_ARGS="\$ENV_ARGS --env http_proxy=\$CI_RUN_PROXY --env https_proxy=\$CI_RUN_PROXY"
    ENV_ARGS="\$ENV_ARGS --env NO_PROXY=localhost,127.0.0.1,::1 --env no_proxy=localhost,127.0.0.1,::1"
fi

# Running as the checkout owner's numeric identity keeps generated
# dependencies, build output and reports writable on the host, and denies the
# permission-sensitive tests root's bypass privileges.
docker run --rm \\
    --user "\$(id -u):\$(id -g)" \\
    ${sandboxOpts()} \\
    -v "\$CI_NSS_DIR/passwd:/etc/passwd:ro" \\
    -v "\$CI_NSS_DIR/group:/etc/group:ro" \\
    \$CACHE_ARG \$ENV_ARGS \\
    -v "\$WORKSPACE:/src" \\
    -v "\$CI_RESULTS_HOST:/ci-results" \\
    ${extraArgs} \\
    "\$CI_IMAGE" pnpm ci:${layer}
"""
}

pipeline {
    agent any

    options {
        // The cache directory and the checkout are shared, so one job cannot
        // run twice at the same time.
        disableConcurrentBuilds()
        timeout(time: 120, unit: 'MINUTES')
        timestamps()
    }

    environment {
        CI_IMAGE        = 'sciencediscovery-ci:test'
        CI_RESULTS_HOST = "${WORKSPACE}/.tmp/ci-results"
        CI_NSS_DIR      = "${WORKSPACE}/.tmp/nss"
    }

    stages {
        stage('Prepare') {
            steps {
                // Start from an empty result directory so the previous build's
                // reports cannot be archived as this build's.
                sh 'rm -rf "$CI_RESULTS_HOST" && mkdir -p "$CI_RESULTS_HOST"'
                sh 'git --no-pager log --oneline -1'
            }
        }

        stage('Toolchain image') {
            steps {
                // The build context is .ci/, so the Dockerfile cannot copy the
                // product checkout into a layer. Fully cached, and therefore a
                // few seconds, whenever .ci/Dockerfile has not changed.
                sh label: 'docker build .ci', script: '''
set -eu
ARGS=""
if [ -n "${CI_NODE_IMAGE:-}" ]; then ARGS="$ARGS --build-arg NODE_IMAGE=$CI_NODE_IMAGE"; fi
if [ -n "${CI_UV_IMAGE:-}" ];   then ARGS="$ARGS --build-arg UV_IMAGE=$CI_UV_IMAGE"; fi
if [ -n "${CI_BUILD_PROXY:-}" ]; then
    # BuildKit's predefined build args: build-time only, never kept in the image
    ARGS="$ARGS --build-arg HTTP_PROXY=$CI_BUILD_PROXY --build-arg HTTPS_PROXY=$CI_BUILD_PROXY"
    ARGS="$ARGS --build-arg http_proxy=$CI_BUILD_PROXY --build-arg https_proxy=$CI_BUILD_PROXY"
fi
docker build $ARGS --file .ci/Dockerfile --tag "$CI_IMAGE" .ci
'''
                prepareNss()
            }
        }

        // The three layers are independent: a red one does not stop the others,
        // and the build still ends red. One build therefore reports every
        // layer's verdict instead of hiding ST behind a UT failure.
        stage('UT') {
            steps {
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    // The aggregate entry point: the host tier followed by the
                    // guest tier, the latter running bubblewrap natively rather
                    // than under QEMU. run-layer.mjs stops at the first failing
                    // command, so a red host tier leaves the guest tier unrun.
                    ciLayer('ut')
                }
            }
        }

        stage('ST') {
            steps {
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    ciLayer('st')
                }
            }
        }

        stage('E2E (mocked)') {
            steps {
                // The E2E stack's data directory lives under /ci-cache and
                // survives builds. Without a reset, state leaks: journeys that
                // assert an empty state find the previous build's providers and
                // Skill library, and report a missing "no providers yet" panel
                // or "Run this journey with fresh isolated Skill library data".
                // envs/ holds the service virtualenvs and must survive.
                sh label: 'reset e2e runtime state', script: '''
set -eu
if [ -n "${CI_CACHE_DIR:-}" ] && [ -d "$CI_CACHE_DIR/sciencediscovery-e2e/data" ]; then
    find "$CI_CACHE_DIR/sciencediscovery-e2e/data" -mindepth 1 -maxdepth 1 \\
         ! -name envs -exec rm -rf {} +
    rm -rf "$CI_CACHE_DIR/sciencediscovery-tests"
fi
'''
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    // E2E_COMMIT_SHA gives journey reports an immutable
                    // revision. The first run provisions the service
                    // environments and Chromium, which the default 180-second
                    // health wait does not cover; that shows up as
                    // "BLOCKED: isolated E2E stack did not become healthy".
                    ciLayer('e2e',
                        '--env E2E_COMMIT_SHA=$(git rev-parse HEAD) ' +
                        '--env CI_E2E_STACK_TIMEOUT_SECONDS=${CI_E2E_STACK_TIMEOUT_SECONDS:-900}')
                }
            }
        }
    }

    post {
        always {
            // run.log, summary.json, stack.log, the Playwright report and the
            // failure screenshots and traces all land here.
            archiveArtifacts artifacts: '.tmp/ci-results/**',
                             allowEmptyArchive: true,
                             fingerprint: false
        }
    }
}
