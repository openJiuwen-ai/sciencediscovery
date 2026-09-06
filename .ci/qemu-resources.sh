#!/usr/bin/env bash
#
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# The facts every resource script has to agree on, stated once.
#
# Each of these used to be a literal repeated across the building, provisioning
# and publishing scripts. The recipe name is what that costs: it was bumped to
# v2 in the published manifest but not in the file baked into the image, so the
# image advertised one generation and carried another, and both guest layers
# died in a preflight assertion that printed nothing.
#
# Sourced, not executed. provision-qemu-runner-image.sh is the one script that
# cannot source this file, because the guest downloads it on its own from the
# seed server; build-qemu-runner-image.sh hands it these values through the
# cloud-init command line instead.

# Bumped whenever the built artifact's contents change, so a consumer that
# fetched an older publish fails its own assertion instead of running on it.
QEMU_RUNNER_RECIPE=qemu-runner-v2
QEMU_EMULATOR_RECIPE=qemu-emulator-v1

QEMU_RUNNER_IMAGE_NAME=ScienceDiscovery-qemu-runner-noble-amd64.qcow2
QEMU_EMULATOR_PAYLOAD_NAME=ScienceDiscovery-qemu-emulator-alpine-x86_64.tar
QEMU_BASE_IMAGE_NAME=noble-server-cloudimg-amd64.img

OBS_CACHE_BASE=https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache

# The toolchain the image bakes in. The checksums that go with each version
# stay beside their download in prepare-codearts-resources.sh, where a version
# bump has to be reviewed together with the hash it changes.
TOOLCHAIN_NODE_VERSION=22.19.0
TOOLCHAIN_PNPM_VERSION=11.1.2
TOOLCHAIN_UV_VERSION=0.9.26
