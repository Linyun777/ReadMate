"""学习笔记的请求与响应模型（方案第 32 节）。"""

from pydantic import BaseModel, Field, field_validator

from app.prompts.note import MAX_ARTICLE_CHARS, MIN_ARTICLE_CHARS

DEFAULT_NOTE_LANGUAGE = "zh-CN"

#: 各列表字段的条数上限。Prompt 没要求这么多，这里只做防御。
MAX_CONCEPTS = 20
MAX_OUTLINE_SECTIONS = 12
MAX_POINTS_PER_SECTION = 10
MAX_TAKEAWAYS = 12


class NoteRequest(BaseModel):
    """一次笔记生成请求。正文由扩展端提取后送来。"""

    text: str = Field(min_length=MIN_ARTICLE_CHARS, max_length=MAX_ARTICLE_CHARS)
    title: str | None = None
    language: str = DEFAULT_NOTE_LANGUAGE
    #: 来源页面地址。写进导出的笔记里，便于日后回溯
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
        return value.strip() or DEFAULT_NOTE_LANGUAGE


class NoteConcept(BaseModel):
    """一个术语及其解释。"""

    term: str
    explanation: str


class NoteSection(BaseModel):
    """笔记的一节。"""

    heading: str
    points: list[str]


class NoteResponse(BaseModel):
    """学习笔记。

    结构化而不是一整段 Markdown 的理由：界面要按层级排版
    （概念是键值对、要点是列表），导出时才拼成 Markdown。
    让模型直接产出 Markdown 会把排版决定塞进 Prompt 里，改版就得改 Prompt。
    """

    #: 一句话定位：这是什么、讲什么
    positioning: str
    #: 核心概念。学习笔记最有价值的部分——日后真正要查的是术语
    concepts: list[NoteConcept]
    #: 分节要点，保留文章的组织
    outline: list[NoteSection]
    #: 值得记住的结论
    takeaways: list[str]
    model: str
    prompt_version: str
