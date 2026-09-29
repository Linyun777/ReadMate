"""总结接口的请求与响应模型（方案第 32 节）。"""

from pydantic import BaseModel, Field, field_validator

from app.prompts.summary import MAX_ARTICLE_CHARS, MIN_ARTICLE_CHARS

DEFAULT_SUMMARY_LANGUAGE = "zh-CN"

#: `points` 的条数上限。Prompt 要求 3–5 条，这里留出余量只做防御。
MAX_POINTS = 10


class SummaryRequest(BaseModel):
    """一次总结请求。

    正文由扩展端提取（Readability）后送来——服务端不接触页面 DOM。
    """

    text: str = Field(min_length=MIN_ARTICLE_CHARS, max_length=MAX_ARTICLE_CHARS)
    title: str | None = None
    #: 总结用什么语言写。默认中文（与扩展的默认目标语言一致）
    language: str = DEFAULT_SUMMARY_LANGUAGE
    #: 来源页面地址。仅用于日志定位，不参与 Prompt
    url: str | None = None

    @field_validator("text")
    @classmethod
    def _text_must_have_content(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("text 不能是空白")
        return value

    @field_validator("language")
    @classmethod
    def _language_must_not_be_blank(cls, value: str) -> str:
        return value.strip() or DEFAULT_SUMMARY_LANGUAGE


class SummaryResponse(BaseModel):
    """总结结果。

    结构化的理由：`gist` 与 `points` 在界面上是两种排版（一句话 vs 列表），
    让模型直接给结构比事后解析自由文本可靠得多。
    """

    #: 一句话主旨
    gist: str
    #: 关键点列表。文章太短或太碎时为空数组
    points: list[str]
    model: str
    prompt_version: str
