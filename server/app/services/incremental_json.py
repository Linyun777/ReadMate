"""流式 JSON 增量解析（方案第 86.9 节）。

模型在流式模式下输出的是一段**逐步到达的 JSON 文本**：

    {"translations":[{"id":"block-001","translation":"你好。"},{"id":"block-002",...

本模块逐块喂入文本，每凑齐一个完整的数组元素就立即产出，
不必等待整个响应结束——这就是「完成一段显示一段」的前提。

**只产出完整元素**：半截的对象永远不会被产出
（方案第 86.9 节：「只转发完整且已校验占位符的段落，不暴露半截内容」）。

结构假设：`{"translations":[{...},{...}]}`。

嵌套深度是这样数的：

```text
{                      ← 深度 1（根对象）
  "translations": [
    { ... }            ← 深度 3，这就是一个「数组元素」
  ]
}
```

因此**元素的起始深度是 3**，闭合后回到 2。元素内部若还有嵌套对象，
深度会到 4，不会与数组元素混淆。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

#: 数组元素所在的嵌套深度（根对象 1 → 数组 2 → 元素 3）
_ITEM_DEPTH = 3


def _try_parse(raw: str) -> dict[str, Any] | None:
    """解析单个元素；不是合法对象时返回 None。"""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


class TranslationStreamParser:
    """增量提取 `translations` 数组中的完整元素。"""

    def __init__(self) -> None:
        self._buffer = ""
        self._cursor = 0
        self._depth = 0
        self._in_string = False
        self._escaped = False
        self._item_start: int | None = None
        #: 解析失败被跳过的元素数。>0 说明模型输出异常，
        #: 最终的结构校验会因此报「缺少 id」并让整批失败。
        self._malformed = 0

    @property
    def malformed(self) -> int:
        return self._malformed

    def feed(self, chunk: str) -> list[dict[str, Any]]:
        """喂入一段文本，返回这次新解析出的完整元素。"""
        if chunk:
            self._buffer += chunk

        items: list[dict[str, Any]] = []
        while self._cursor < len(self._buffer):
            char = self._buffer[self._cursor]

            if self._in_string:
                if self._escaped:
                    self._escaped = False
                elif char == "\\":
                    self._escaped = True
                elif char == '"':
                    self._in_string = False
            elif char == '"':
                self._in_string = True
            elif char in "{[":
                self._depth += 1
                if char == "{" and self._depth == _ITEM_DEPTH:
                    self._item_start = self._cursor
            elif char in "}]":
                self._depth -= 1
                if char == "}" and self._depth == _ITEM_DEPTH - 1 and self._item_start is not None:
                    raw = self._buffer[self._item_start : self._cursor + 1]
                    self._item_start = None

                    parsed = _try_parse(raw)
                    if parsed is None:
                        self._malformed += 1
                    else:
                        items.append(parsed)

            self._cursor += 1

        self._trim_buffer()

        return items

    def _trim_buffer(self) -> None:
        """丢弃已经处理过、且不会再被引用的前缀。

        ⚠️ 只能裁到「当前元素的开头」为止。裁过头会把 `_item_start` 指向的位置
        一起丢掉，元素闭合时就取不到完整的原文了——跨块边界的元素会静默丢失。
        """
        keep_from = self._item_start if self._item_start is not None else self._cursor
        if keep_from <= 0:
            return

        self._buffer = self._buffer[keep_from:]
        self._cursor -= keep_from
        if self._item_start is not None:
            self._item_start -= keep_from

    def reset(self) -> None:
        self._buffer = ""
        self._cursor = 0
        self._depth = 0
        self._in_string = False
        self._escaped = False
        self._item_start = None
        self._malformed = 0


def iter_json_objects(text: str) -> Iterator[dict[str, Any]]:
    """一次性解析（非流式场景用，便于测试与对照）。"""
    parser = TranslationStreamParser()
    yield from parser.feed(text)
