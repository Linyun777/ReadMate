"""解释接口的请求与响应模型（方案第 41 节）。"""

from pydantic import BaseModel, Field, field_validator

from app.prompts.explain import MAX_SELECTION_CHARS

DEFAULT_EXPLAIN_LANGUAGE = "zh-CN"


class ExplainRequest(BaseModel):
    """一次解释请求。

    `selection` 是用户在页面上选中的文字；`context` 是它所在的段落（可选，
    但给了会让解释准确得多——同一个词在不同语境里意思可能完全不同）。
    """

    selection: str = Field(min_length=1, max_length=MAX_SELECTION_CHARS)
    context: str | None = None
    #: 解释用什么语言写。默认中文（与扩展的默认目标语言一致）
    language: str = DEFAULT_EXPLAIN_LANGUAGE
    #: 来源页面地址。仅用于日志定位，不参与 Prompt
    url: str | None = None

    @field_validator("selection")
    @classmethod
    def _selection_must_not_be_blank(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("selection 不能是空白")
        return value

    @field_validator("language")
    @classmethod
    def _language_must_not_be_blank(cls, value: str) -> str:
        return value.strip() or DEFAULT_EXPLAIN_LANGUAGE


class ExplainResponse(BaseModel):
    explanation: str
    model: str
    prompt_version: str
