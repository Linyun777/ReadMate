"""批次预算的跨语言一致性。

## 为什么值得专门测

Batch 预算（字符数 / 条目数）**有两份实现**：

| 位置 | 语言 |
| --- | --- |
| `extension/shared/constants.ts` | TypeScript（生产） |
| `server/scripts/measure_translation_cost.py` | Python（测量脚本） |

跨语言共享要引构建步骤，为一个测量脚本不值得——所以这份重复是**刻意的**。

代价是两边会漂：改了一边忘了另一边，测量脚本算出来的成本就与生产不是
一回事，而**它跑起来完全正常，不报任何错**。这类不一致没有别的测试能发现。

实际发生过：那条「两边都要改」的提醒记的路径
`extension/core/translator/constants.ts` 早就不存在了——**提醒本身先漂了**，
接手的人按它去找只会扑空。所以这里除了比数值，也把那个旧路径钉住。
"""

from __future__ import annotations

import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BASE_DIR.parent

TS_CONSTANTS = REPO_ROOT / 'extension' / 'shared' / 'constants.ts'
MEASURE_SCRIPT = BASE_DIR / 'scripts' / 'measure_translation_cost.py'

#: 常量已经搬到这里了——旧路径不该再出现，见 test_没有指向已搬家的常量文件
STALE_TS_PATH = 'core/translator/constants.ts'

#: 扫描范围：源码与文档（跳过依赖、构建产物与本地产物）
SCAN_SUFFIXES = {'.md', '.ts', '.py', '.json'}
SCAN_SKIP_DIRS = {'node_modules', '.git', '.output', '.wxt', '.venv', '.pytest_cache'}

#: 本文件自己要写出那个旧路径才能断言它「不该出现」，所以跳过自己
SELF = Path(__file__).resolve()


def _number(pattern: str, text: str, source: Path) -> int:
    match = re.search(pattern, text, re.MULTILINE)
    assert match is not None, f'{source.name} 里找不到 {pattern!r}——改名了？'
    return int(match.group(1).replace('_', ''))


def ts_values() -> tuple[int, int]:
    text = TS_CONSTANTS.read_text(encoding='utf-8')
    return (
        _number(r'export const MAX_CHARS_PER_BATCH = ([\d_]+)', text, TS_CONSTANTS),
        _number(r'export const MAX_ITEMS_PER_BATCH = ([\d_]+)', text, TS_CONSTANTS),
    )


def py_values() -> tuple[int, int]:
    text = MEASURE_SCRIPT.read_text(encoding='utf-8')
    return (
        _number(r'^MAX_BATCH_CHARS\s*=\s*([\d_]+)', text, MEASURE_SCRIPT),
        _number(r'^MAX_BATCH_ITEMS\s*=\s*([\d_]+)', text, MEASURE_SCRIPT),
    )


class TestBatchBudget:
    def test_字符预算两边一致(self) -> None:
        """⭐ 不一致的话，测量脚本报的成本与生产不是一回事。"""
        ts_chars, _ = ts_values()
        py_chars, _ = py_values()

        assert ts_chars == py_chars, (
            f'字符预算漂了：TS {ts_chars} / Python {py_chars}。\n'
            f'改了一边忘了另一边——测量结果会失真，但不会有任何报错。'
        )

    def test_条目预算两边一致(self) -> None:
        _, ts_items = ts_values()
        _, py_items = py_values()

        assert ts_items == py_items, f'条目预算漂了：TS {ts_items} / Python {py_items}。'

    def test_常量文件确实存在(self) -> None:
        """常量文件是这两份预算的共同源头，它没了这两份都无从校验。"""
        assert TS_CONSTANTS.is_file(), f'常量文件不存在：{TS_CONSTANTS}'

    def test_没有指向已搬家的常量文件(self) -> None:
        """⭐ 防止「提醒本身先漂了」。

        这条提醒写的是「Batch 预算有两份实现、改的时候两边都要改」，
        但它自己指的文件 `core/translator/constants.ts` **已经不存在了**
        （常量搬到了 `shared/constants.ts`）。接手的人按它去找只会扑空。

        所以钉住的不是「数值对不对」，而是「这个旧路径不该再被提到」——
        与 `adapters/no-domain-in-core.test.ts` 同一思路：用扫描把约束钉死。
        """
        hits: list[str] = []

        for path in sorted(REPO_ROOT.rglob('*')):
            if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
                continue
            if SCAN_SKIP_DIRS & set(path.parts):
                continue
            if path.resolve() == SELF:
                continue
            if STALE_TS_PATH in path.read_text(encoding='utf-8', errors='ignore'):
                hits.append(str(path.relative_to(REPO_ROOT)))

        assert not hits, (
            f'这些文件里还写着 {STALE_TS_PATH}：{hits}\n'
            f'那个文件已经不存在了，常量在 {TS_CONSTANTS.relative_to(REPO_ROOT)}。'
        )
