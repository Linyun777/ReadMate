"""结构化校验测试（方案第 72 节、第 86.1 节）。"""

import pytest

from app.services.validation import (
    StructureError,
    extract_placeholders,
    validate_ids,
    validate_placeholders,
)


class TestExtractPlaceholders:
    def test_无占位符(self) -> None:
        assert extract_placeholders("Hello world") == []

    def test_成对占位符(self) -> None:
        refs = extract_placeholders("Hello <0>world</0>!")

        assert [(ref.index, ref.kind) for ref in refs] == [(0, "pair")]

    def test_原子占位符(self) -> None:
        refs = extract_placeholders("Line one<0/>Line two")

        assert [(ref.index, ref.kind) for ref in refs] == [(0, "atom")]

    def test_闭合标签不重复计数(self) -> None:
        refs = extract_placeholders("<0>a</0> and <0>b</0>")

        assert [ref.index for ref in refs] == [0]

    def test_混合类型按出现顺序(self) -> None:
        refs = extract_placeholders("a<0>b</0>c<1/>d<2>e</2>")

        assert [ref.index for ref in refs] == [0, 1, 2]
        assert [ref.kind for ref in refs] == ["pair", "atom", "pair"]


class TestValidatePlaceholders:
    def test_一致时通过(self) -> None:
        validate_placeholders(
            "AI is changing <0>software</0> fast.<1/>Read the <2>docs</2>.",
            "AI 正在快速改变<0>软件</0>。<1/>请阅读<2>文档</2>。",
        )

    def test_原文无占位符时译文也不得有(self) -> None:
        validate_placeholders("Hello world", "你好，世界")
        with pytest.raises(StructureError, match="索引不一致"):
            validate_placeholders("Hello world", "你好<0>世界</0>")

    def test_缺少占位符(self) -> None:
        with pytest.raises(StructureError, match="缺少"):
            validate_placeholders("See <0>docs</0> now", "现在看文档")

    def test_多出占位符(self) -> None:
        with pytest.raises(StructureError, match="多出"):
            validate_placeholders("Hello world", "你好<0>世界</0>")

    def test_索引重复(self) -> None:
        with pytest.raises(StructureError, match="重复"):
            validate_placeholders("a<0>b</0>c<1>d</1>", "a<0>b</0>c<0>d</0>")

    def test_成对占位符未闭合(self) -> None:
        with pytest.raises(StructureError, match="未闭合"):
            validate_placeholders("See <0>docs</0> now", "看<0>文档 现在")

    def test_成对占位符交叉嵌套(self) -> None:
        with pytest.raises(StructureError, match="配对错误"):
            validate_placeholders("<0>a<1>b</1></0>", "<0>甲<1>乙</0></1>")

    def test_允许重排占位符(self) -> None:
        """模型会为符合目标语言语序而重排——这是正确行为，不是错误。

        实测见 `scripts/check_placeholder_retention.py`。
        """
        validate_placeholders("a<0>x</0>b<1>y</1>", "a<1>y</1>b<0>x</0>")

    def test_真实重排用例(self) -> None:
        """实测中出现的真实重排（中英语序差异）。

        英文把 JSON 放在 HTTP 之前，中文习惯反过来。强制保持顺序会逼出
        别扭的译文，因此校验刻意不检查顺序。
        """
        validate_placeholders(
            "The <0>LLM</0> returns a <1>JSON</1> payload over <2>HTTP</2>.",
            "<0>LLM</0>通过<2>HTTP</2>返回一个<1>JSON</1>负载。",
        )

    def test_原子占位符不需要闭合(self) -> None:
        validate_placeholders("a<0/>b", "甲<0/>乙")

    def test_成对占位符多了闭合标签(self) -> None:
        with pytest.raises(StructureError, match="配对错误"):
            validate_placeholders("a<0>b</0>", "甲<0>乙</0></0>")


class TestValidateIds:
    def test_一致时通过(self) -> None:
        validate_ids(["a", "b", "c"], ["c", "a", "b"])

    def test_缺少_id(self) -> None:
        with pytest.raises(StructureError, match="缺少"):
            validate_ids(["a", "b", "c"], ["a", "b"])

    def test_多出未知_id(self) -> None:
        with pytest.raises(StructureError, match="多出"):
            validate_ids(["a", "b"], ["a", "b", "z"])

    def test_重复_id(self) -> None:
        with pytest.raises(StructureError, match="重复"):
            validate_ids(["a", "b"], ["a", "a"])

    def test_同时缺少与多出(self) -> None:
        with pytest.raises(StructureError) as exc_info:
            validate_ids(["a", "b"], ["a", "z"])

        assert "缺少" in exc_info.value.reason
        assert "多出" in exc_info.value.reason
