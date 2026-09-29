"""总结接口（方案第 32 节）。

Router 只负责 HTTP —— 不承载任何模型调用逻辑（方案第 70 节）。
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.deps import get_summary_llm_client
from app.clients.base import LLMClient
from app.schemas.summary import SummaryRequest, SummaryResponse
from app.services.summary_service import SummaryFailedError, SummaryService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["summary"])


@router.post("/summary", response_model=SummaryResponse)
async def summarize(
    request: SummaryRequest,
    client: LLMClient = Depends(get_summary_llm_client),
) -> SummaryResponse:
    """总结一篇文章。

    正文由扩展端用 Readability 提取后送来——服务端不接触页面 DOM
    （方案第 62 节：提取必须在页面上下文里做）。
    """
    try:
        return await SummaryService(client).summarize(request)
    except SummaryFailedError as exc:
        # 上游失败：与翻译 / 解释接口保持一致，用 502 而不是 500
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=exc.reason,
        ) from exc
