"""v1 路由聚合。

分层约定（方案第 70 节）：Router 只负责 HTTP，不承载任何模型调用逻辑。
"""

from fastapi import APIRouter

from app.api.v1 import config, explain, health, note, summary, translate, usage

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(translate.router)
api_router.include_router(explain.router)
api_router.include_router(summary.router)
api_router.include_router(note.router)
api_router.include_router(usage.router)
api_router.include_router(config.router)
