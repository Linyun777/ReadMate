"""学习笔记服务（方案第 32 节）。

与 `SummaryService` 的关系：**结构相似、目标不同**。

  总结：压缩成「读完就知道大概」，`gist` + 几条 `points`
  笔记：重组成「日后能捡起来」，定位 + 概念 + 分节要点 + 结论

两者共用同一套「解析 → 宽容校验」的思路，但 Prompt 与字段完全不同，
因此没有互相复用——复用会引入一堆用不上的分支。
"""

import json
import logging

from app.clients.base import ChatMessage, LLMClient, LLMError
from app.core.usage_ledger import get_ledger
from app.prompts.note import (
    NOTE_PROMPT_VERSION,
    build_note_system_prompt,
    build_note_user_prompt,
)
from app.schemas.note import (
    MAX_CONCEPTS,
    MAX_OUTLINE_SECTIONS,
    MAX_POINTS_PER_SECTION,
    MAX_TAKEAWAYS,
    NoteConcept,
    NoteRequest,
    NoteResponse,
    NoteSection,
)

logger = logging.getLogger(__name__)


class NoteFailedError(Exception):
    """笔记生成失败。`reason` 可直接写进响应。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _clean_list(raw: object, limit: int) -> list[str]:
    """把任意值收成「非空字符串列表」，超出上限截断。"""
    if not isinstance(raw, list):
        return []

    items: list[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip() != "":
            items.append(item.strip())
        if len(items) >= limit:
            break

    return items


class NoteService:
    def __init__(self, client: LLMClient) -> None:
        self._client = client

    async def make_note(self, request: NoteRequest) -> NoteResponse:
        messages = [
            ChatMessage(role="system", content=build_note_system_prompt(request.language)),
            ChatMessage(
                role="user",
                content=build_note_user_prompt(text=request.text, title=request.title),
            ),
        ]

        try:
            completion = await self._client.complete_with_usage(messages, json_mode=True)
        except LLMError as exc:
            raise NoteFailedError(str(exc)) from exc

        get_ledger().record(
            endpoint='note',
            model=self._client.model_name,
            usage=completion.usage,
        )

        note = self._parse(completion.text)

        logger.info(
            "note ok chars=%d concepts=%d sections=%d language=%s usage=%s",
            len(request.text),
            len(note.concepts),
            len(note.outline),
            request.language,
            completion.usage,
        )

        return NoteResponse(
            positioning=note.positioning,
            concepts=note.concepts,
            outline=note.outline,
            takeaways=note.takeaways,
            model=self._client.model_name,
            prompt_version=NOTE_PROMPT_VERSION,
        )

    @staticmethod
    def _parse(raw: str) -> NoteResponse:
        """解析模型输出。

        校验尺度与总结一致：**只有定位缺失才报错，其余字段宽容**。
        理由是笔记比总结更长，因为某一节格式不对就整篇失败，代价太高——
        宁可少一节，也要把已经拿到的内容交出去。
        """
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise NoteFailedError("模型返回的不是合法 JSON") from exc

        if not isinstance(payload, dict):
            raise NoteFailedError("模型返回的 JSON 不是对象")

        positioning = payload.get("positioning")
        if not isinstance(positioning, str) or positioning.strip() == "":
            raise NoteFailedError("模型返回的 JSON 缺少 positioning")

        return NoteResponse(
            positioning=positioning.strip(),
            concepts=NoteService._parse_concepts(payload.get("concepts")),
            outline=NoteService._parse_outline(payload.get("outline")),
            takeaways=_clean_list(payload.get("takeaways"), MAX_TAKEAWAYS),
            model="",
            prompt_version=NOTE_PROMPT_VERSION,
        )

    @staticmethod
    def _parse_concepts(raw: object) -> list[NoteConcept]:
        if not isinstance(raw, list):
            return []

        concepts: list[NoteConcept] = []
        for item in raw:
            if not isinstance(item, dict):
                continue

            term = item.get("term")
            explanation = item.get("explanation")
            if not isinstance(term, str) or not isinstance(explanation, str):
                continue
            if term.strip() == "" or explanation.strip() == "":
                continue

            concepts.append(NoteConcept(term=term.strip(), explanation=explanation.strip()))
            if len(concepts) >= MAX_CONCEPTS:
                break

        return concepts

    @staticmethod
    def _parse_outline(raw: object) -> list[NoteSection]:
        if not isinstance(raw, list):
            return []

        sections: list[NoteSection] = []
        for item in raw:
            if not isinstance(item, dict):
                continue

            heading = item.get("heading")
            if not isinstance(heading, str) or heading.strip() == "":
                continue

            points = _clean_list(item.get("points"), MAX_POINTS_PER_SECTION)
            if not points:
                continue

            sections.append(NoteSection(heading=heading.strip(), points=points))
            if len(sections) >= MAX_OUTLINE_SECTIONS:
                break

        return sections
