"""健康检查（方案第 16.1 节）。

扩展在发起翻译前先探测服务是否在线。

返回中带上 provider / model / summaryModel / promptVersion：
  - provider 让扩展与开发者一眼看出当前是否跑在 mock 模式
  - model 与 promptVersion 参与扩展端**缓存键**计算（方案第 86.8 节）
  - summaryModel 只用于展示与排查，**不参与缓存键**

`model` 必须与翻译响应里的 `model` 一致，否则缓存永远命中不了——
两者都由 `resolve_model_name()` 给出。

**不返回任何 API Key 相关信息。**
"""

from fastapi import APIRouter

from app.clients.factory import resolve_model_name, resolve_summary_model_name
from app.core.config import get_settings
from app.prompts.translation import PROMPT_VERSION

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "provider": settings.llm_provider,
        # 翻译用的模型。**必须与翻译响应的 `model` 一致**——它参与扩展端的
        # 缓存键计算，两者不一致会导致缓存永远命中不了（方案第 86.8 节）。
        "model": resolve_model_name(settings),
        # 总结 / 学习笔记用的模型。仅用于展示与排查，不参与缓存键。
        "summaryModel": resolve_summary_model_name(settings),
        "promptVersion": PROMPT_VERSION,
    }
