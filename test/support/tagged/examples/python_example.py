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

import pytest
from science_tags import normalize_tags

pytestmark = pytest.mark.science_tags(
    category='ut', os=('linux', 'macos', 'windows'), arch=('amd64', 'arm64'),
    )


@pytest.mark.parametrize('tag', ['model:moke', 'judge:hybrid'], ids=['bad-model', 'bad-judge'])
def test_rejects_unknown_values(tag):
    with pytest.raises(ValueError, match='Unknown tag'):
        normalize_tags([tag])
