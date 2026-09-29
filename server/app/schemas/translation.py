"""翻译接口的 Pydantic 模型。

依据方案第 86.5 节。

**线上格式用 snake_case**（`source_language` / `target_language` / `context_id`），
与方案第 16.2、86.5 节的示例一致。扩展端的 TS 类型用 camelCase，
序列化时由扩展侧的 api-client 做映射（Phase 5）。
"""

from typing import Literal

from pydantic import BaseModel, Field

TranslationStyle = Literal["natural", "technical", "academic", "literal"]


class TranslationItem(BaseModel):
    """一个待翻译单元。对应扩展端的一个 TranslationBlock。"""

    id: str = Field(min_length=1)
    #: 含占位符的文本，形如 `AI is changing<0>software</0> fast.`
    text: str = Field(min_length=1)


class TranslateRequest(BaseModel):
    """翻译请求。"""

    source_language: str = "auto"
    target_language: str = "zh-CN"
    style: TranslationStyle = "natural"

    #: 整篇文章共享的上下文（per-Article，方案第 86.6 节）
    #: 放在 Prompt 最前部以利用 Provider 的 prompt caching
    context_id: str | None = None
    context: str | None = None

    items: list[TranslationItem] = Field(min_length=1)


class TranslationResult(BaseModel):
    """单个条目的翻译结果。"""

    id: str
    #: 回填原文，方便扩展端调试与日志（不由模型返回）
    source: str
    #: 含占位符的译文
    translation: str


class TranslateResponse(BaseModel):
    """翻译响应。"""

    context_id: str | None = None
    prompt_version: str
    model: str
    items: list[TranslationResult]


class LLMTranslationItem(BaseModel):
    """模型被要求返回的最小结构（方案第 18 节）。

    只含 `id` 与 `translation`——`source` 由服务端回填，
    不让模型重复输出，既省 token 也避免它改写原文。
    """

    id: str
    translation: str


class LLMTranslationPayload(BaseModel):
    """模型输出的顶层结构：`{"translations": [...]}`。"""

    translations: list[LLMTranslationItem]
