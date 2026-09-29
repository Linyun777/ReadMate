"""解释服务（方案第 41 节）。

与 `TranslationService` 的关系：**结构相似、Prompt 与校验完全不同**。

  - 翻译要校验 JSON 结构与占位符（输出必须严格对齐输入）
  - 解释是自由文本，没有结构可校验，只需保证非空

因此这里没有复用 `TranslationService`——复用会引入一堆用不上的校验参数。
"""

import logging

from app.clients.base import ChatMessage, LLMClient, LLMError
from app.core.usage_ledger import get_ledger
from app.prompts.explain import (
    EXPLAIN_PROMPT_VERSION,
    build_explain_system_prompt,
    build_explain_user_prompt,
)
from app.schemas.explain import ExplainRequest, ExplainResponse

logger = logging.getLogger(__name__)


class ExplainFailedError(Exception):
    """解释失败。`reason` 可直接写进响应。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ExplainService:
    def __init__(self, client: LLMClient) -> None:
        self._client = client

    async def explain(self, request: ExplainRequest) -> ExplainResponse:
        messages = [
            ChatMessage(
                role="system",
                content=build_explain_system_prompt(request.language),
            ),
            ChatMessage(
                role="user",
                content=build_explain_user_prompt(
                    selection=request.selection,
                    context=request.context,
                ),
            ),
        ]

        try:
            completion = await self._client.complete_with_usage(messages, json_mode=False)
        except LLMError as exc:
            raise ExplainFailedError(str(exc)) from exc

        get_ledger().record(
            endpoint='explain',
            model=self._client.model_name,
            usage=completion.usage,
        )

        raw = completion.text
        explanation = raw.strip()
        if explanation == "":
            raise ExplainFailedError("模型返回了空解释")

        logger.info(
            "explain ok selection=%d chars language=%s usage=%s",
            len(request.selection),
            request.language,
            completion.usage,
        )

        return ExplainResponse(
            explanation=explanation,
            model=self._client.model_name,
            prompt_version=EXPLAIN_PROMPT_VERSION,
        )
