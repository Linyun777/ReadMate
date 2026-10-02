"""目录树（`DEVELOPMENT_PLAN.md` 第 0.5 节）与实际结构必须一致。

## 为什么值得专门测

`AGENTS.md` 第 6 节明确规定：**目录树不写在 `AGENTS.md`，只写在计划文档第 0.5 节**
——理由是「两边各存一份必然走形」。可这条约定成立的前提
（「第 0.5 节那份是准的」）**此前没有任何东西守着**。

2026-10-02 审计发现它已经悄悄落后了好几个 Phase：少 7 个 `core/` 模块
（`reader` / `explain` / `summary` / `note` / `export` / `usage` / `panel`）、
少 `OPEN_ISSUES.md`、少 `entrypoints/` 下的 `reader/` 与 `sidepanel/`，
抬头还写着「截至 Phase 13」。而它是接手的人看到的第一张地图。

这里做**双向**校验（与 `test_env_example.py` 同一个思路）：
  1. 树里写的每个路径都必须真的存在（条目删了/改名了，树里还留着）
  2. 受关注的目录下新增的条目必须出现在树里（加了东西忘了画）

⚠️ 公开副本不含这份文档，所以在那边整体 skip。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BASE_DIR.parent
PLAN = REPO_ROOT / 'DEVELOPMENT_PLAN.md'

TREE_HEADING = '## 0.5'
TREE_BLOCK = re.compile(r'^```text\n(.*?)^```', re.M | re.DOTALL)

#: 反向校验范围：这些目录下新增的条目必须出现在树里。
#: 只挑「一眼能看出漏了东西」的层级——更深的地方靠人写注释，不靠测试。
WATCHED_DIRS = (
    'extension/core',
    'extension/entrypoints',
    'server/app',
    'server/app/api/v1',
    'server/scripts',
)

#: 不画进树的噪声
IGNORED_NAMES = {'__init__.py', '__pycache__'}

pytestmark = pytest.mark.skipif(
    not PLAN.is_file(),
    reason='公开副本不含 DEVELOPMENT_PLAN.md（那是开发主线才有的文档）',
)


def parse_tree() -> dict[str, str]:
    """把第 0.5 节里的目录树解析成 `{相对仓库根的路径: 原始行}`。

    树用 `├──` / `└──` 与 `│   ` / 四个空格表示层级；一行里用 ` / ` 并列多个
    兄弟条目（`package.json / package-lock.json`）。条目名里的 `/` 是路径分隔符
    （`tests/fixtures/pages/`），所以两者不能混。
    """
    text = PLAN.read_text(encoding='utf-8')
    found = TREE_BLOCK.search(text, text.index(TREE_HEADING))
    assert found is not None, '第 0.5 节里找不到 ```text 目录树'

    paths: dict[str, str] = {}

    # 先把纯分隔线（`│`、`│   │`）滤掉——不滤的话它们会伪装成「根那一行」，
    # 把层级栈重置掉，结果所有条目都变成根级的（踩过）。
    lines = [line for line in found.group(1).splitlines() if line.strip(' │')]

    # stack[depth] = 该层的父路径。根那行（`Web_Translator/`）之后是空串，
    # 于是下面的路径都相对仓库根。
    stack: list[str] = ['']

    for index, raw in enumerate(lines):
        depth = 0
        rest = raw
        while rest.startswith(('│   ', '    ')):
            rest = rest[4:]
            depth += 1

        if not rest.startswith(('├── ', '└── ')):
            # 只剩树的根那一行会走到这里
            assert index == 0, f'看不懂的树行：{raw!r}'
            continue

        body = rest[4:].split('#', 1)[0].strip()
        if not body:
            continue

        parent = stack[depth] if depth < len(stack) else stack[-1]
        first_name = ''

        for token in body.split(' / '):
            name = token.strip().rstrip('/')
            if not name:
                continue
            first_name = first_name or name
            paths['/'.join(part for part in (parent, name) if part)] = raw

        # 这一行的「主条目」成为下一层的父
        stack = stack[: depth + 1]
        stack.append('/'.join(part for part in (parent, first_name) if part))

    return paths


class TestDocsStructure:
    def test_树里的每个路径都存在(self) -> None:
        """⭐ 条目删了或改名了，树里却还留着——这正是一年前发生的事。"""
        missing = [rel for rel in parse_tree() if not (REPO_ROOT / rel).exists()]

        assert not missing, (
            f'第 0.5 节的目录树里写了这些路径，但它们不存在：\n  '
            + '\n  '.join(missing)
            + '\n请同步更新 DEVELOPMENT_PLAN.md 第 0.5 节。'
        )

    def test_新增的条目都画进了树里(self) -> None:
        """⭐ 加了模块却忘了画——树是接手的人看到的第一张地图。"""
        tree = set(parse_tree())
        missing: list[str] = []

        for watched in WATCHED_DIRS:
            base = REPO_ROOT / watched
            if not base.is_dir():
                continue
            for entry in sorted(base.iterdir()):
                if entry.name in IGNORED_NAMES or entry.name.startswith('.'):
                    continue
                rel = f'{watched}/{entry.name}'
                if rel not in tree:
                    missing.append(rel)

        assert not missing, (
            f'这些条目没画进第 0.5 节的目录树：\n  '
            + '\n  '.join(missing)
            + '\n（`AGENTS.md` 第 6 节要求目录树只存在于这一处，所以它得是准的。）'
        )

    def test_根目录的文档都画进了树里(self) -> None:
        tree = set(parse_tree())
        missing = [p.name for p in sorted(REPO_ROOT.glob('*.md')) if p.name not in tree]

        assert not missing, f'根目录这些文档没画进树里：{missing}'

    def test_解析出的树不是空的(self) -> None:
        """守住解析器本身：哪天树的写法变了，别让上面几条「空跑通过」。"""
        tree = parse_tree()

        assert len(tree) > 40, f'只解析出 {len(tree)} 个条目，解析器大概没跟上树的写法'
        assert 'extension/core/segmenter' in tree
        assert 'server/app/main.py' in tree
