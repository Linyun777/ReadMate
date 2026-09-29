"""Mock LLM 客户端。

用于本地开发与 E2E：**返回确定性结果，不发起任何网络请求**
（方案第 86.9 节：E2E 不得发起真实模型请求）。

通过 `mode` 模拟各种异常返回，以便测试校验路径：

    ok                正常返回，保留占位符
    drop-placeholder  丢掉第一个占位符（验证占位符校验）
    missing-id        少返回一个条目（验证 ID 完整性校验）
    duplicate-id      重复返回一个条目
    invalid-json      返回非 JSON 文本（验证解析失败路径）
"""

import asyncio
import json
import re
from collections.abc import AsyncIterator

from app.clients.base import ChatMessage, Completion, LLMError, Usage
from app.core.config import MockMode
from app.prompts.translation import ITEMS_CLOSE_TAG, ITEMS_OPEN_TAG

ITEMS_PATTERN = re.compile(
    re.escape(ITEMS_OPEN_TAG) + r"\s*(.*?)\s*" + re.escape(ITEMS_CLOSE_TAG),
    re.DOTALL,
)

#: 解释请求里的选中文本块（方案第 41 节）
SELECTION_PATTERN = re.compile(r"<selection>\s*(.*?)\s*</selection>", re.DOTALL)

#: 总结 / 笔记请求里的正文块（方案第 32 节）
ARTICLE_PATTERN = re.compile(r"<article>\s*(.*?)\s*</article>", re.DOTALL)

#: 笔记请求的 system prompt 里的特征串。
#:
#: 笔记与总结**用的是同一个 `<article>` 块**，靠正文分不出来，
#: 只能看 system prompt 的意图。
NOTE_MARKER = "study notes"

#: 译文的确定性前缀，便于在测试中断言
MOCK_PREFIX = "【译】"

#: 解释的确定性前缀
MOCK_EXPLAIN_PREFIX = "【释】"

#: 总结的确定性前缀
MOCK_SUMMARY_PREFIX = "【摘】"

#: 笔记的确定性前缀
MOCK_NOTE_PREFIX = "【记】"

_FIRST_PLACEHOLDER = re.compile(r"<(\d+)")


class MockLLMClient:
    """确定性 LLM 替身。"""

    def __init__(
        self,
        *,
        mode: MockMode = "ok",
        model: str = "mock",
        stream_delay_ms: int = 0,
    ) -> None:
        self._mode: MockMode = mode
        self._model = model
        self._stream_delay_ms = max(0, stream_delay_ms)

    @property
    def model_name(self) -> str:
        return self._model

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> str:
        return self._build(messages)

    def complete_stream(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> AsyncIterator[str]:
        """把完整响应切成若干段逐步产出，模拟流式。

        切成多段是必要的：E2E 要验证「完成一段就渲染一段」，
        一次性吐出整段就测不出增量行为。

        `stream_delay_ms` 让每段之间留出间隔，E2E 借此观察中间状态；
        默认 0，不影响常规测试的速度。
        """
        return self._stream(self._build(messages))

    async def complete_with_usage(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> Completion:
        """同 `complete`，附一个**确定性**的假用量。

        按 4 字符 / token 粗算——只为让调用方能跑通，
        **不代表真实模型的 token 数**（成本测量要用真实 Provider）。
        """
        text = await self.complete(messages, json_mode=json_mode)

        prompt_chars = sum(len(message.content) for message in messages)
        prompt_tokens = max(1, prompt_chars // 4)
        completion_tokens = max(1, len(text) // 4)

        return Completion(
            text=text,
            usage=Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
        )

    def _build(self, messages: list[ChatMessage]) -> str:
        if self._mode == "invalid-json":
            return "抱歉，我无法完成这个请求。"

        # 解释请求走另一条路径：输出是自由文本，不是 JSON（方案第 41 节）
        selection = self._extract_selection(messages)
        if selection is not None:
            return self._build_explanation(selection)

        # 总结 / 笔记也是另一条路径：输出都是结构化 JSON（方案第 32 节）
        # 两者共用 <article> 块，靠 system prompt 的意图区分
        article = self._extract_article(messages)
        if article is not None:
            if self._is_note_request(messages):
                return self._build_note(article)
            return self._build_summary(article)

        items = self._extract_items(messages)
        if items is None:
            raise LLMError("Mock 客户端未能从用户消息中解析出 <items> 块")

        translations: list[dict[str, str]] = [
            {"id": item["id"], "translation": f"{MOCK_PREFIX}{item['text']}"}
            for item in items
        ]

        if self._mode == "drop-placeholder":
            # 作用于第一个**确实含占位符**的条目，否则这个模式起不到效果
            for entry in translations:
                if _FIRST_PLACEHOLDER.search(entry["translation"]):
                    entry["translation"] = self._drop_first_placeholder(entry["translation"])
                    break
        elif self._mode == "missing-id" and len(translations) > 1:
            translations.pop()
        elif self._mode == "duplicate-id" and translations:
            translations.append(dict(translations[0]))

        return json.dumps({"translations": translations}, ensure_ascii=False)

    async def _stream(self, text: str) -> AsyncIterator[str]:
        """按固定段长切分，逐步产出。"""
        chunk_size = max(8, len(text) // 4)

        for start in range(0, len(text), chunk_size):
            if start > 0 and self._stream_delay_ms > 0:
                await asyncio.sleep(self._stream_delay_ms / 1000)

            yield text[start : start + chunk_size]

    @staticmethod
    def _drop_first_placeholder(text: str) -> str:
        """删掉第一个占位符（成对的连同闭合标签一起删），制造「缺占位符」场景。"""
        match = _FIRST_PLACEHOLDER.search(text)
        if match is None:
            return text

        index = match.group(1)
        return re.sub(rf"<{index}/?>|</{index}>", "", text)

    @staticmethod
    def _build_explanation(selection: str) -> str:
        """确定性的解释结果。

        与翻译一样加前缀，便于测试断言「这确实来自 mock」。
        """
        return f"{MOCK_EXPLAIN_PREFIX}{selection}"

    @staticmethod
    def _is_note_request(messages: list[ChatMessage]) -> bool:
        """判断这是不是笔记请求。看 system prompt 的意图，不看正文。"""
        return any(
            message.role == "system" and NOTE_MARKER in message.content for message in messages
        )

    @staticmethod
    def _build_note(article: str) -> str:
        """确定性的笔记结果。

        结构与真实 Prompt 约定一致，这样校验路径与真实模型走的是同一条。
        """
        return json.dumps(
            {
                "positioning": f"{MOCK_NOTE_PREFIX}{article[:40].strip()}",
                "concepts": [
                    {"term": f"{MOCK_NOTE_PREFIX}概念一", "explanation": "解释一"},
                    {"term": f"{MOCK_NOTE_PREFIX}概念二", "explanation": "解释二"},
                ],
                "outline": [
                    {
                        "heading": f"{MOCK_NOTE_PREFIX}小节一",
                        "points": ["要点一", "要点二"],
                    },
                    {"heading": f"{MOCK_NOTE_PREFIX}小节二", "points": ["要点三"]},
                ],
                "takeaways": [f"{MOCK_NOTE_PREFIX}结论一", f"{MOCK_NOTE_PREFIX}结论二"],
            },
            ensure_ascii=False,
        )

    @staticmethod
    def _build_summary(article: str) -> str:
        """确定性的总结结果。

        结构与真实 Prompt 约定一致（`gist` + `points`），
        这样校验路径与真实模型走的是同一条。
        """
        return json.dumps(
            {
                "gist": f"{MOCK_SUMMARY_PREFIX}{article[:40].strip()}",
                "points": [
                    f"{MOCK_SUMMARY_PREFIX}要点一",
                    f"{MOCK_SUMMARY_PREFIX}要点二",
                    f"{MOCK_SUMMARY_PREFIX}要点三",
                ],
            },
            ensure_ascii=False,
        )

    @staticmethod
    def _extract_article(messages: list[ChatMessage]) -> str | None:
        """从用户消息的 `<article>` 块里取出正文。"""
        for message in messages:
            if message.role != "user":
                continue

            match = ARTICLE_PATTERN.search(message.content)
            if match is not None:
                return match.group(1).strip()

        return None

    @staticmethod
    def _extract_selection(messages: list[ChatMessage]) -> str | None:
        """从用户消息的 `<selection>` 块里取出选中文本。"""
        for message in messages:
            if message.role != "user":
                continue

            match = SELECTION_PATTERN.search(message.content)
            if match is not None:
                return match.group(1).strip()

        return None

    @staticmethod
    def _extract_items(messages: list[ChatMessage]) -> list[dict[str, str]] | None:
        """从用户消息的 `<items>` 块里取出待翻译条目。"""
        for message in messages:
            if message.role != "user":
                continue

            match = ITEMS_PATTERN.search(message.content)
            if match is None:
                continue

            try:
                parsed = json.loads(match.group(1))
            except json.JSONDecodeError:
                return None

            if not isinstance(parsed, list):
                return None

            items: list[dict[str, str]] = []
            for entry in parsed:
                if isinstance(entry, dict) and "id" in entry and "text" in entry:
                    items.append({"id": str(entry["id"]), "text": str(entry["text"])})
            return items

        return None
