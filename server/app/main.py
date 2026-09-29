"""FastAPI 应用入口。

分层（方案第 70 节）：

    API Router → TranslationService → PromptService → LLMClient → Provider

Phase 0 只落地 Router 与健康检查；TranslationService 及其下层在 Phase 4 实现。
"""

from fastapi import FastAPI

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="伴读 · ReadMate API",
        version="2.1.0",
        docs_url="/docs",
        redoc_url=None,
    )
    app.include_router(api_router, prefix="/api/v1")

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {
            "service": "ai-web-translator",
            "docs": "/docs",
            "health": "/api/v1/health",
            "provider": settings.llm_provider,
        }

    return app


app = create_app()
