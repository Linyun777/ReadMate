"""翻译接口（方案第 16.2 节）。

Router 只负责 HTTP —— 不承载任何模型调用逻辑（方案第 70 节）。
"""

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from app.api.v1.deps import get_llm_client
from app.clients.base import LLMClient, LLMError
from app.core.config import Settings, get_settings
from app.schemas.translation import TranslateRequest, TranslateResponse
from app.services.translation_service import TranslationFailedError, TranslationService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["translate"])

#: 再导出：测试与其他端点都从这里取依赖
__all__ = ["router", "get_llm_client"]


def get_translation_service(
    settings: Settings = Depends(get_settings),
    client: LLMClient = Depends(get_llm_client),
) -> TranslationService:
    return TranslationService(client, json_mode=settings.llm_json_mode)


@router.post("/translate", response_model=TranslateResponse)
async def translate(
    request: TranslateRequest,
    service: TranslationService = Depends(get_translation_service),
) -> TranslateResponse:
    """批量翻译。

    失败时返回明确错误，**绝不返回半结构化内容**（方案第 72 节）。
    """
    try:
        return await service.translate(request)
    except TranslationFailedError as exc:
        # 结构校验失败：上游返回了不符合约定的内容
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=exc.reason,
        ) from exc
    except LLMError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc


@router.post("/translate/stream")
async def translate_stream(
    request: TranslateRequest,
    service: TranslationService = Depends(get_translation_service),
) -> StreamingResponse:
    """流式翻译（方案第 86.9 节）。

    以 **NDJSON** 逐行下发，每行一个事件：

    ```text
    {"type":"item","id":"block-001","source":"...","translation":"..."}
    {"type":"done","prompt_version":"v1","model":"deepseek-chat"}
    ```

    失败时下发 `{"type":"error","reason":"..."}`。

    选 NDJSON 而非 SSE：两边都只需按行切分，不引入额外的事件格式约定；
    方案第 86.9 节允许「SSE 或分块 HTTP」。

    **已经下发过的条目在后续失败时仍然有效**——调用方应保留它们。
    """

    async def generate() -> AsyncIterator[str]:
        try:
            async for event in service.translate_stream(request):
                yield json.dumps(event.to_payload(), ensure_ascii=False) + "\n"
        except Exception as exc:  # noqa: BLE001
            # 兜底：未预期的异常若直接抛出，响应会被截断，
            # 调用方无法把它和「正常结束」区分开
            logger.exception("流式翻译未预期失败")
            payload = {"type": "error", "reason": f"服务端异常：{exc}"}
            yield json.dumps(payload, ensure_ascii=False) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            # 逐行下发的前提是中间层不缓冲
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )
