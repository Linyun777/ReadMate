"""总结服务（方案第 32 节）。

与 `TranslationService` / `ExplainService` 的关系：**结构相似、校验完全不同**。

  翻译：输出必须**严格对齐输入结构**（ID 完整性 + 占位符配对）
  解释：自由文本，只需非空
  总结：**结构化的自由文本**——`gist` 必填，`points` 是列表但允许为空

三者各有一套 Prompt 与校验，因此没有互相复用。共用会引入一堆用不上的参数。
"""

import json
import logging

from app.clients.base import ChatMessage, LLMClient, LLMError
from app.core.usage_ledger import get_ledger
from app.prompts.summary import (
    SUMMARY_PROMPT_VERSION,
    build_summary_system_prompt,
    build_summary_user_prompt,
)
from app.schemas.summary import MAX_POINTS, SummaryRequest, SummaryResponse

logger = logging.getLogger(__name__)


class SummaryFailedError(Exception):
    """总结失败。`reason` 可直接写进响应。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class SummaryService:
    def __init__(self, client: LLMClient) -> None:
        self._client = client

    async def summarize(self, request: SummaryRequest) -> SummaryResponse:
        messages = [
            ChatMessage(
                role="system",
                content=build_summary_system_prompt(request.language),
            ),
            ChatMessage(
                role="user",
                content=build_summary_user_prompt(text=request.text, title=request.title),
            ),
        ]

        try:
            completion = await self._client.complete_with_usage(messages, json_mode=True)
        except LLMError as exc:
            raise SummaryFailedError(str(exc)) from exc

        get_ledger().record(
            endpoint='summary',
            model=self._client.model_name,
            usage=completion.usage,
        )

        gist, points = self._parse(completion.text)

        logger.info(
            "summary ok chars=%d points=%d language=%s usage=%s",
            len(request.text),
            len(points),
            request.language,
            completion.usage,
        )

        return SummaryResponse(
            gist=gist,
            points=points,
            model=self._client.model_name,
            prompt_version=SUMMARY_PROMPT_VERSION,
        )

    @staticmethod
    def _parse(raw: str) -> tuple[str, list[str]]:
        """解析模型输出。

        只做**必要的**校验：`gist` 必须有内容，`points` 里的非法项直接丢弃。
        理由：总结是给人看的，少一条要点比整次失败好得多——
        这一点与翻译不同（翻译缺一条就是结构损坏，绝不能渲染）。
        """
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SummaryFailedError("模型返回的不是合法 JSON") from exc

        if not isinstance(payload, dict):
            raise SummaryFailedError("模型返回的 JSON 不是对象")

        gist = payload.get("gist")
        if not isinstance(gist, str) or gist.strip() == "":
            raise SummaryFailedError("模型返回的 JSON 缺少 gist")

        points: list[str] = []
        raw_points = payload.get("points")
        if isinstance(raw_points, list):
            for item in raw_points:
                if isinstance(item, str) and item.strip() != "":
                    points.append(item.strip())
                if len(points) >= MAX_POINTS:
                    break

        return gist.strip(), points
