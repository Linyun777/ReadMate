"""解释接口（方案第 41 节）。

Router 只负责 HTTP —— 不承载任何模型调用逻辑（方案第 70 节）。
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.deps import get_llm_client
from app.clients.base import LLMClient
from app.schemas.explain import ExplainRequest, ExplainResponse
from app.services.explain_service import ExplainFailedError, ExplainService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["explain"])


@router.post("/explain", response_model=ExplainResponse)
async def explain(
    request: ExplainRequest,
    client: LLMClient = Depends(get_llm_client),
) -> ExplainResponse:
    """解释一段选中的文字。

    与 `/translate` 的区别：翻译是**转换**（输出必须严格对齐输入结构），
    解释是**补充**（自由文本，没有结构可校验）。两者的 Prompt 与校验都不同。
    """
    try:
        return await ExplainService(client).explain(request)
    except ExplainFailedError as exc:
        # 上游失败：与翻译接口保持一致，用 502 而不是 500
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=exc.reason,
        ) from exc
