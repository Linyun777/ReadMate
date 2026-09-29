"""翻译编排（方案第 70 节：Service 负责编排）。

流程（方案第 72 节）：

    PromptService 组装 messages
    ↓
    LLMClient.complete 取回原始文本
    ↓
    JSON 解析 → Pydantic 校验 → ID 完整性 → 占位符校验
    ↓
    TranslateResponse

**任一环节失败都不返回半结构化内容**（方案第 72 节）。
"""

import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

from pydantic import ValidationError as PydanticValidationError

from app.clients.base import LLMClient, LLMError
from app.core.usage_ledger import get_ledger
from app.prompts.translation import PROMPT_VERSION
from app.schemas.translation import (
    LLMTranslationPayload,
    TranslateRequest,
    TranslateResponse,
    TranslationItem,
    TranslationResult,
)
from app.services.incremental_json import TranslationStreamParser
from app.services.prompt_service import PromptService
from app.services.validation import StructureError, validate_ids, validate_placeholders

logger = logging.getLogger(__name__)

#: JSON 解析或结构校验失败时的额外尝试次数（方案第 24.3 节：可重试一次）
DEFAULT_PARSE_RETRIES = 1

_MARKDOWN_FENCE_OPEN = re.compile(r"^```[A-Za-z0-9_-]*\s*")
_MARKDOWN_FENCE_CLOSE = re.compile(r"\s*```$")


class TranslationFailedError(Exception):
    """翻译失败且已用尽重试。`reason` 可直接写进响应。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class StreamEvent:
    """流式翻译下发的一个事件（方案第 86.9 节）。

    三种类型：
      - `item`  —— 一个**完整且已校验占位符**的条目，可以立即渲染
      - `done`  —— 全部完成，附 prompt 版本与模型名
      - `error` —— 失败；已下发过的条目仍然有效
    """

    type: Literal["item", "done", "error"]
    item: TranslationResult | None = None
    prompt_version: str | None = None
    model: str | None = None
    reason: str | None = None

    def to_payload(self) -> dict[str, object]:
        """转成线上格式（NDJSON 的一行）。"""
        if self.type == "item" and self.item is not None:
            return {
                "type": "item",
                "id": self.item.id,
                "source": self.item.source,
                "translation": self.item.translation,
            }
        if self.type == "done":
            return {
                "type": "done",
                "prompt_version": self.prompt_version,
                "model": self.model,
            }
        return {"type": "error", "reason": self.reason or "未知错误"}


def extract_json_object(text: str) -> str:
    """从模型输出中提取 JSON 对象文本。

    依次尝试：直接使用 → 去掉 markdown 围栏 → 截取最外层花括号。
    模型偶尔会加解释性前后缀或包一层代码块，这里统一容错。
    """
    stripped = text.strip()

    if stripped.startswith("```"):
        stripped = _MARKDOWN_FENCE_OPEN.sub("", stripped)
        stripped = _MARKDOWN_FENCE_CLOSE.sub("", stripped).strip()

    if stripped.startswith("{"):
        return stripped

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end > start:
        return stripped[start : end + 1]

    return stripped


class TranslationService:
    """翻译编排。"""

    def __init__(
        self,
        client: LLMClient,
        *,
        prompt_service: PromptService | None = None,
        json_mode: bool = True,
        parse_retries: int = DEFAULT_PARSE_RETRIES,
    ) -> None:
        self._client = client
        self._prompts = prompt_service or PromptService()
        self._json_mode = json_mode
        self._parse_retries = max(0, parse_retries)

    @property
    def model_name(self) -> str:
        return self._client.model_name

    async def translate(self, request: TranslateRequest) -> TranslateResponse:
        """执行一次翻译。失败抛 `TranslationFailedError`。"""
        messages = self._prompts.build_messages(request)
        attempts = self._parse_retries + 1
        last_reason = "未知错误"

        for attempt in range(1, attempts + 1):
            completion = await self._client.complete_with_usage(messages, json_mode=self._json_mode)
            raw = completion.text
            get_ledger().record(
                endpoint='translate',
                model=self._client.model_name,
                usage=completion.usage,
            )

            try:
                payload = self._parse(raw)
                self._validate(request, payload)
            except StructureError as exc:
                last_reason = exc.reason
                logger.warning(
                    "结构校验失败（第 %d/%d 次）：%s",
                    attempt,
                    attempts,
                    last_reason,
                )
                continue

            return self._build_response(request, payload)

        raise TranslationFailedError(f"结构校验失败（已尝试 {attempts} 次）：{last_reason}")

    async def translate_stream(self, request: TranslateRequest) -> AsyncIterator[StreamEvent]:
        """流式翻译：**每凑齐一个完整且已校验的条目就立即下发**。

        方案第 86.9 节：
          - 只下发**完整且已校验占位符**的段落，不暴露半截内容
          - 整个响应结束后再做一次权威校验（ID 完整性）

        失败时下发 `error` 事件。**已经下发过的条目仍然有效**——
        调用方应保留它们，只把没拿到的那些当作失败，而不是整批丢弃。
        """
        messages = self._prompts.build_messages(request)
        by_id = {item.id: item for item in request.items}
        delivered: dict[str, str] = {}
        issues: list[str] = []
        parser = TranslationStreamParser()

        try:
            async for delta in self._client.complete_stream(messages, json_mode=self._json_mode):
                for raw in parser.feed(delta):
                    item = self._validate_stream_item(raw, by_id, delivered, issues)
                    if item is None:
                        continue

                    delivered[item.id] = item.translation
                    yield StreamEvent(type="item", item=item)
        except LLMError as exc:
            yield StreamEvent(type="error", reason=str(exc))
            return

        if issues:
            yield StreamEvent(type="error", reason="结构校验失败：" + "；".join(issues))
            return

        try:
            validate_ids([item.id for item in request.items], list(delivered.keys()))
        except StructureError as exc:
            yield StreamEvent(type="error", reason=f"结构校验失败：{exc.reason}")
            return

        yield StreamEvent(
            type="done",
            prompt_version=PROMPT_VERSION,
            model=self._client.model_name,
        )

    @staticmethod
    def _validate_stream_item(
        raw: dict[str, object],
        by_id: dict[str, TranslationItem],
        delivered: dict[str, str],
        issues: list[str],
    ) -> TranslationResult | None:
        """校验单个流式条目。不合格时返回 `None`（该条目视为未下发）。

        **宁可整批最终失败，也不下发结构损坏的条目**——渲染出去就挽回不了了。
        不合格的原因累积进 `issues`，最终统一报出，便于定位。
        """
        item_id = raw.get("id")
        translation = raw.get("translation")

        if not isinstance(item_id, str) or not isinstance(translation, str):
            issues.append("流式条目缺少 id 或 translation")
            return None

        source = by_id.get(item_id)
        if source is None:
            issues.append(f"返回了未请求的 id：{item_id}")
            return None

        if item_id in delivered:
            issues.append(f"id 重复下发：{item_id}")
            return None

        if not translation.strip():
            issues.append(f"条目 {item_id} 的译文为空")
            return None

        try:
            validate_placeholders(source.text, translation)
        except StructureError as exc:
            issues.append(f"条目 {item_id} 占位符校验失败：{exc.reason}")
            return None

        return TranslationResult(id=item_id, source=source.text, translation=translation)

    @staticmethod
    def _parse(raw: str) -> LLMTranslationPayload:
        """把模型输出解析成 `LLMTranslationPayload`。

        Pydantic 的原始报错对调用方过于冗长（含 input_value 等调试信息），
        这里压缩成一句可读说明。
        """
        try:
            return LLMTranslationPayload.model_validate_json(extract_json_object(raw))
        except PydanticValidationError as exc:
            errors = exc.errors()
            first = errors[0] if errors else {}
            location = ".".join(str(part) for part in first.get("loc", ()))
            message = str(first.get("msg", exc))
            where = f"（字段 {location}）" if location else ""
            raise StructureError(f"模型输出不符合约定结构{where}：{message}") from exc

    @staticmethod
    def _validate(request: TranslateRequest, payload: LLMTranslationPayload) -> None:
        """ID 完整性 + 逐条占位符校验。"""
        validate_ids(
            [item.id for item in request.items],
            [item.id for item in payload.translations],
        )

        by_id = {item.id: item for item in payload.translations}
        for item in request.items:
            translation = by_id[item.id].translation
            if not translation.strip():
                raise StructureError(f"条目 {item.id} 的译文为空")
            validate_placeholders(item.text, translation)

    def _build_response(
        self,
        request: TranslateRequest,
        payload: LLMTranslationPayload,
    ) -> TranslateResponse:
        by_id = {item.id: item for item in payload.translations}

        return TranslateResponse(
            context_id=request.context_id,
            prompt_version=PROMPT_VERSION,
            model=self._client.model_name,
            items=[
                TranslationResult(
                    id=item.id,
                    source=item.text,
                    translation=by_id[item.id].translation,
                )
                for item in request.items
            ],
        )
