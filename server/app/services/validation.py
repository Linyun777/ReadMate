"""结构化输出校验（方案第 72 节、第 86.1 节）。

⚠️ **本模块与扩展端 `core/segmenter/placeholders.ts` 的 `validatePlaceholders`
是同一套规则的两份实现，必须保持一致。**

分工：
  - 服务端：返回前校验，以便触发段落级修复请求（方案第 86.1 节）
  - 扩展端：写 DOM 前做最后一道防线（铁律：结构校验失败绝不渲染）

改动任一方时请同步另一方。
"""

from dataclasses import dataclass
from re import Pattern, compile
from typing import Literal, Sequence

#: 匹配 `<0>` / `<0/>` / `</0>`
TOKEN_PATTERN: Pattern[str] = compile(r"<(\d+)(/?)>|</(\d+)>")


class StructureError(Exception):
    """结构校验失败。

    `reason` 是可以直接写进日志或响应里的中文说明。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class PlaceholderRef:
    index: int
    kind: Literal["pair", "atom"]


def extract_placeholders(text: str) -> list[PlaceholderRef]:
    """解析文本中的占位符，按**首次出现顺序**返回（闭合标签不计入）。"""
    refs: list[PlaceholderRef] = []
    seen: set[int] = set()

    for match in TOKEN_PATTERN.finditer(text):
        open_index, self_closing, close_index = match.groups()
        if close_index is not None:
            continue

        index = int(open_index)
        if index in seen:
            continue

        seen.add(index)
        refs.append(PlaceholderRef(index=index, kind="atom" if self_closing else "pair"))

    return refs


def validate_placeholders(source_text: str, translation: str) -> None:
    """校验译文中的占位符与原文一致。不一致时抛 `StructureError`。

    两条规则（与扩展端一致）：

    1. 索引集合完全一致（不缺失、不多余、不重复）
    2. 成对占位符开闭数量相等且配对正确（不交叉嵌套）

    **刻意不校验顺序。** 实测（`scripts/check_placeholder_retention.py`）发现
    模型会为了符合目标语言语序而重排占位符，例如：

        The <0>LLM</0> returns a <1>JSON</1> payload over <2>HTTP</2>.
        → <0>LLM</0>通过<2>HTTP</2>返回一个<1>JSON</1>负载。

    这是**正确行为**，不是错误——强制保持顺序会逼出别扭的译文
    （「返回一个 JSON 负载通过 HTTP」）。重排对 DOM 也是安全的：
    元素仍包裹各自的译文，只是块内位置变化，Renderer 按译文的顺序重建即可。

    检查顺序是刻意的：**先查索引集合、再查配对**。反过来会让
    「译文多出一个占位符」被误报成「配对错误」，掩盖真正的原因。
    """
    expected = extract_placeholders(source_text)
    expected_indices = [ref.index for ref in expected]
    expected_pairs = {ref.index for ref in expected if ref.kind == "pair"}

    # 第一遍：收集译文中的占位符索引（不含闭合标签）
    found: list[int] = []
    for match in TOKEN_PATTERN.finditer(translation):
        open_index, _self_closing, close_index = match.groups()
        if close_index is not None:
            continue
        found.append(int(open_index))

    # 第二遍：索引集合
    if len(set(found)) != len(found):
        raise StructureError("占位符索引出现重复")

    if set(found) != set(expected_indices):
        missing = sorted(set(expected_indices) - set(found))
        extra = sorted(set(found) - set(expected_indices))
        details: list[str] = []
        if missing:
            details.append("缺少 " + "、".join(f"<{index}>" for index in missing))
        if extra:
            details.append("多出 " + "、".join(f"<{index}>" for index in extra))
        raise StructureError("占位符索引不一致：" + "；".join(details))

    # 第三遍：成对占位符的配对（用栈检测交叉嵌套）
    stack: list[int] = []
    for match in TOKEN_PATTERN.finditer(translation):
        open_index, self_closing, close_index = match.groups()

        if close_index is not None:
            index = int(close_index)
            if not stack or stack[-1] != index:
                raise StructureError(f"成对占位符 </{index}> 配对错误")
            stack.pop()
            continue

        index = int(open_index)
        if not self_closing and index in expected_pairs:
            stack.append(index)

    if stack:
        unclosed = "、".join(f"<{index}>" for index in stack)
        raise StructureError(f"成对占位符未闭合：{unclosed}")


def validate_ids(requested: Sequence[str], returned: Sequence[str]) -> None:
    """校验模型返回的 id 集合与请求一致（方案第 72 节）。

    检查 missing id / duplicate id / unknown id。任一不满足即整个 Batch 失败。
    """
    if len(set(returned)) != len(returned):
        raise StructureError("返回的 id 出现重复")

    requested_set = set(requested)
    returned_set = set(returned)

    if requested_set == returned_set:
        return

    missing = sorted(requested_set - returned_set)
    unknown = sorted(returned_set - requested_set)

    details: list[str] = []
    if missing:
        details.append("缺少 " + "、".join(missing))
    if unknown:
        details.append("多出 " + "、".join(unknown))

    raise StructureError("id 集合与请求不一致：" + "；".join(details))
