"""pytest 全局夹具。"""

import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.core import usage_ledger


@pytest.fixture
def temp_dir() -> Iterator[Path]:
    """一个干净的临时目录，**不依赖 pytest 的 `tmp_path`**。

    `tmp_path` 走 `--basetemp`，目录按当前用户命名（`pytest-of-root` /
    `pytest-of-linyun`）。本机出现过「沙箱内以 root 跑过一次，之后沙箱外
    以普通用户跑就 EEXIST 报错」的情况——**十几个测试全挂**，
    而且报错指向 pytest 内部，看起来像代码坏了。

    `tempfile` 每次拿全新目录，与 pytest 的机制无关。
    """
    with tempfile.TemporaryDirectory(prefix='wt-test-') as directory:
        yield Path(directory)


@pytest.fixture(autouse=True)
def isolate_usage_ledger() -> Iterator[None]:
    """把用量台账重定向到临时目录。

    **测试绝不能写真实台账。** 第一次接台账时忘了这层隔离，
    跑一遍测试就往 `server/.usage.jsonl` 里塞了 9 条 mock 记录——
    真实的用量统计从此掺进了假数据，而且看不出哪些是假的。

    这类污染很隐蔽：数字看起来正常，只是偏大。

    ## 为什么用 `tempfile` 而不是 `tmp_path`

    `tmp_path` 走的是 pytest 的 `--basetemp` 机制，目录按**当前用户**命名
    （`pytest-of-root` / `pytest-of-linyun`）。本机出现过「沙箱内以 root 跑过
    一次，之后沙箱外以普通用户跑就 `EEXIST` 报错」的情况——150 个测试全挂，
    而且报错指向 pytest 内部，看起来像代码坏了。

    `tempfile.mkdtemp()` 每次拿一个全新目录，与 pytest 的机制无关。
    """
    original = usage_ledger._ledger

    with tempfile.TemporaryDirectory(prefix='wt-usage-') as directory:
        usage_ledger._ledger = usage_ledger.UsageLedger(Path(directory) / '.usage.jsonl')
        yield
        usage_ledger._ledger = original
