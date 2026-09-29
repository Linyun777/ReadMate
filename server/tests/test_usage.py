"""用量捕获测试（成本测量的基础）。

`complete_with_usage` 是后加的方法：`complete` 的调用方不关心用量，
改签名会波及全部调用点与测试。这里覆盖新增的部分。
"""

import asyncio
from types import SimpleNamespace

from app.clients.base import ChatMessage, Completion, Usage
from app.clients.mock import MockLLMClient
from app.clients.openai_compatible import OpenAICompatibleClient


def fake_usage(**fields: int) -> SimpleNamespace:
    return SimpleNamespace(**fields)


class TestUsageArithmetic:
    def test_相加(self) -> None:
        a = Usage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        b = Usage(prompt_tokens=20, completion_tokens=7, total_tokens=27)

        total = a + b

        assert total.prompt_tokens == 30
        assert total.completion_tokens == 12
        assert total.total_tokens == 42


class TestToUsage:
    """把 SDK 的 usage 转成本项目的 Usage。"""

    def test_标准三个字段(self) -> None:
        usage = OpenAICompatibleClient._to_usage(
            fake_usage(prompt_tokens=100, completion_tokens=50, total_tokens=150)
        )

        assert usage == Usage(prompt_tokens=100, completion_tokens=50, total_tokens=150)

    def test_缺少_total_时自己算(self) -> None:
        usage = OpenAICompatibleClient._to_usage(
            fake_usage(prompt_tokens=100, completion_tokens=50)
        )

        assert usage is not None
        assert usage.total_tokens == 150

    def test_完全没有_usage_时返回_None(self) -> None:
        assert OpenAICompatibleClient._to_usage(None) is None

    def test_字段不全时返回_None_而不是猜(self) -> None:
        """部分兼容接口只返回 total——宁可不报，也不报一个错的数。"""
        assert OpenAICompatibleClient._to_usage(fake_usage(total_tokens=150)) is None
        assert OpenAICompatibleClient._to_usage(fake_usage(prompt_tokens=100)) is None


class TestMockUsage:
    def test_返回确定性的用量(self) -> None:
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="a" * 400),
            ChatMessage(role="user", content='<items>\n[{"id":"b1","text":"Hello."}]\n</items>'),
        ]

        completion = asyncio.run(client.complete_with_usage(messages))

        assert isinstance(completion, Completion)
        assert completion.usage is not None
        # 400 + 其余字符，按 4 字符 / token 粗算
        assert completion.usage.prompt_tokens > 100
        assert completion.usage.completion_tokens > 0
        assert (
            completion.usage.total_tokens
            == completion.usage.prompt_tokens + completion.usage.completion_tokens
        )

    def test_文本与_complete_一致(self) -> None:
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="whatever"),
            ChatMessage(role="user", content='<items>\n[{"id":"b1","text":"Hello."}]\n</items>'),
        ]

        plain = asyncio.run(client.complete(messages))
        with_usage = asyncio.run(client.complete_with_usage(messages))

        assert with_usage.text == plain
