"""三处版本号必须一致。

## 为什么值得专门测

版本号**写在四个地方**，而此前没有任何东西守住它们一致：

| 位置 | 用途 | 用户在哪看到 |
| --- | --- | --- |
| `extension/package.json` | npm 包版本 | 终端里的 `npm` 输出 |
| `extension/wxt.config.ts` | Chrome 扩展版本 | **`chrome://extensions`** |
| `extension/package-lock.json` | lock 的根版本 | 一般不直接看，但会与 `package.json` 对不上 |
| `server/app/main.py` | FastAPI 的 `version=` | **`/docs`（OpenAPI）与 `/health`** |

改了一处忘了另一处，用户在两个地方看到的数字就不一样——**而这类不一致
没有任何其他测试能发现**：两边各自都跑得好好的。

`tests/test_env_example.py` 是同一个思路（把「没人守的约定」钉住），
`tests/test_batch_budget.py` 也是（跨语言常量）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BASE_DIR.parent

PKG = REPO_ROOT / 'extension' / 'package.json'
LOCK = REPO_ROOT / 'extension' / 'package-lock.json'
WXT_CONFIG = REPO_ROOT / 'extension' / 'wxt.config.ts'
MAIN = BASE_DIR / 'app' / 'main.py'

#: `manifest.version`——Chrome 扩展版本，`chrome://extensions` 显示的就是它
WXT_VERSION = re.compile(r"^\s*version:\s*'([^']+)'", re.MULTILINE)
#: FastAPI 的 `version=`——出现在 `/docs` 与 OpenAPI schema 里
API_VERSION = re.compile(r'^\s*version="([^"]+)"', re.MULTILINE)
SEMVER = re.compile(r'^\d+\.\d+\.\d+$')

PLACES = {
    'extension/package.json': lambda: json.loads(PKG.read_text(encoding='utf-8'))['version'],
    'extension/package-lock.json': lambda: json.loads(LOCK.read_text(encoding='utf-8'))['version'],
    'extension/wxt.config.ts': lambda: _match(WXT_VERSION, WXT_CONFIG),
    'server/app/main.py': lambda: _match(API_VERSION, MAIN),
}


def _match(pattern: re.Pattern[str], path: Path) -> str:
    found = pattern.search(path.read_text(encoding='utf-8'))
    assert found is not None, f'{path.name} 里找不到版本号——写法变了？'
    return found.group(1)


class TestVersionConsistency:
    def test_四处版本号一致(self) -> None:
        """⭐ 这是这个文件存在的理由。

        报错时把四处都打出来，一眼看出是哪一处漏改了。
        """
        versions = {place: read() for place, read in PLACES.items()}
        distinct = set(versions.values())

        assert len(distinct) == 1, (
            f'版本号不一致：{json.dumps(versions, ensure_ascii=False, indent=2)}\n'
            f'改版本时四处都要改（见 DEVELOPMENT_PLAN.md「版本号写在三处」）。'
        )

    def test_版本号是三段式(self) -> None:
        for place, read in PLACES.items():
            assert SEMVER.match(read()), f'{place} 的版本号不是 x.y.z 形状：{read()!r}'

    def test_lock_文件内部两处版本一致(self) -> None:
        """`package-lock.json` 里有两处：根 `version` 与 `packages[""].version`。

        只改一处会让 `npm ci` 报「lock 与 package.json 不同步」。
        """
        lock = json.loads(LOCK.read_text(encoding='utf-8'))
        root = lock.get('packages', {}).get('', {}).get('version')

        assert root == lock['version'], (
            f'package-lock.json 内部就不一致：根 {lock["version"]!r} '
            f'vs packages[""] {root!r}'
        )
