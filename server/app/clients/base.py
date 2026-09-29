"""LLM 客户端接口（方案第 70、71 节）。

**职责边界**：只负责「把消息发出去、把原始文本拿回来」——
不解析、不校验、不组装 Prompt。

编排在 `TranslationService`，Prompt 在 `PromptService`（方案第 70 节的分层）。

> 注：方案第 71 节给出的示例签名是 `translate(request) -> response`，
> 但那会把编排职责塞进 Client，与第 70 节「Client 只负责 Provider 通信」冲突。
> 这里按第 70 节执行。
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class Usage:
    """一次调用的 token 用量。

    Provider 不一定返回（部分兼容接口省略 `usage`），因此调用方必须容忍 `None`。
    """

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            total_tokens=self.total_tokens + other.total_tokens,
        )


@dataclass(frozen=True)
class Completion:
    """一次调用的结果：文本 + 用量。

    为什么不用「客户端上挂一个 last_usage 属性」：客户端是并发复用的，
    属性会被别的请求覆盖——测量结果会静默错乱。
    """

    text: str
    usage: Usage | None = None


class LLMError(Exception):
    """Provider 通信失败。

    `retryable` 表示是否值得重试——网络错误、429、5xx 为真，
    4xx（除 429）与配置错误为假（方案第 73 节）。
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


class LLMClient(Protocol):
    """Provider 通信层。"""

    @property
    def model_name(self) -> str:
        """当前使用的模型标识，会回写到响应里供扩展端记录。"""
        ...

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> str:
        """发送消息，返回模型输出的原始文本。

        `json_mode` 为真时请求 Provider 返回 JSON 对象
        （OpenAI 的 `response_format`）；不支持的 Provider 可忽略。
        """
        ...

    async def complete_with_usage(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> Completion:
        """同 `complete`，但**一并返回 token 用量**。

        单独一个方法而不是改 `complete` 的返回类型：`complete` 的调用方
        （翻译 / 解释 / 总结）不关心用量，改签名会波及全部调用点与测试。
        需要用量的是成本测量与可观测性。
        """
        ...

    def complete_stream(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> AsyncIterator[str]:
        """流式发送消息，**逐段**产出模型输出的文本增量。

        注意这是普通方法（不是 `async def`）——它返回一个异步迭代器，
        调用方直接 `async for` 即可，不需要先 `await`。

        方案第 86.9 节要求「完成一段就显示一段」，这是其数据来源。
        """
        ...
