"""用量接口（成本可见性）。

只报告 **token 数**，不报告金额。

理由：token 是事实，价格是外部输入且会变。把价格写进 API 意味着
「换个 Provider 或官方调价，API 就开始说谎」。金额由调用方
（`scripts/report_usage.py` 或界面）按自己掌握的价格算。
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.usage_ledger import get_ledger

logger = logging.getLogger(__name__)

router = APIRouter(tags=["usage"])


class BucketUsage(BaseModel):
    calls: int
    prompt_tokens: int
    completion_tokens: int


class UsageResponse(BaseModel):
    """累计用量。

    `calls` 是**成功记录到用量的调用次数**——Provider 未返回 usage 的调用
    不会被计入（跳过而不是记 0，记 0 会让人以为「调用过但没花钱」）。
    """

    calls: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    by_endpoint: dict[str, BucketUsage]
    by_model: dict[str, BucketUsage]
    first_at: str | None
    last_at: str | None
    #: 台账文件位置，便于手工核对
    ledger_path: str


class ClearResponse(BaseModel):
    cleared: int


@router.get("/usage", response_model=UsageResponse)
async def read_usage() -> UsageResponse:
    """读出累计用量。"""
    ledger = get_ledger()
    summary = ledger.summarize()

    return UsageResponse(
        calls=summary.calls,
        prompt_tokens=summary.prompt_tokens,
        completion_tokens=summary.completion_tokens,
        total_tokens=summary.total_tokens,
        by_endpoint={key: BucketUsage(**value) for key, value in summary.by_endpoint.items()},
        by_model={key: BucketUsage(**value) for key, value in summary.by_model.items()},
        first_at=summary.first_at,
        last_at=summary.last_at,
        ledger_path=str(ledger.path),
    )


@router.delete("/usage", response_model=ClearResponse)
async def clear_usage() -> ClearResponse:
    """清空台账。用于「我从现在开始重新计数」。"""
    return ClearResponse(cleared=get_ledger().clear())
