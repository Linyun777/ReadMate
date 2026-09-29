"""学习笔记接口（方案第 32 节）。

Router 只负责 HTTP —— 不承载任何模型调用逻辑（方案第 70 节）。
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.deps import get_summary_llm_client
from app.clients.base import LLMClient
from app.schemas.note import NoteRequest, NoteResponse
from app.services.note_service import NoteFailedError, NoteService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["note"])


@router.post("/note", response_model=NoteResponse)
async def make_note(
    request: NoteRequest,
    client: LLMClient = Depends(get_summary_llm_client),
) -> NoteResponse:
    """把一篇文章做成学习笔记。

    与 `/summary` 的区别：总结是压缩（读完知道大概），笔记是重组
    （日后能捡起来）。因此字段、Prompt、长度都不同。

    复用总结的客户端：两者都是「理解型」任务，与翻译的诉求不同，
    用同一个模型配置是合理的。
    """
    try:
        return await NoteService(client).make_note(request)
    except NoteFailedError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=exc.reason,
        ) from exc
