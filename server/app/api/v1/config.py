"""运行时配置接口（方案第 39 节的延伸）。

让用户在**设置页**改 LLM 连接信息，不必手工编辑 `server/.env`。

## 改的是 `.env` 本身

不是另存一份覆盖文件——那会变成两个真相来源，用户手工改 `.env` 之后
两边不一致，谁都说不清哪个生效。

写入走 `core/env_file.update_env_file`：逐行编辑、保留注释与顺序、原子替换。

## ⚠️ API Key 只进不出

`GET` 只返回 `hasApiKey` 布尔值，**绝不返回 key 本身**。
理由见 `schemas/config.py`。

## ⚠️ 这个接口会改服务端配置

**部署到公网前必须加认证**——否则任何人都能把你的服务指向别处、
或者用你的 Key 刷额度。目前靠绑定 `127.0.0.1` 保护。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from app.api.v1.deps import reset_llm_client_cache
from app.clients.factory import resolve_model_name, resolve_summary_model_name
from app.core.config import ENV_FILE, get_settings
from app.core.env_file import update_env_file
from app.schemas.config import ConfigResponse, ConfigUpdate

router = APIRouter(tags=['config'])

#: 只允许改这几个键。写死成白名单，避免接口被用来改 HOST / PORT 之类
#: 需要重启才生效、且改错会让服务起不来的配置。
ALLOWED_KEYS = ('LLM_BASE_URL', 'LLM_MODEL', 'LLM_SUMMARY_MODEL', 'LLM_API_KEY')


def env_file_path() -> Path:
    """`.env` 的位置。

    抽成函数便于测试替换；同时受 `ENV_FILE_PATH` 环境变量控制
    （E2E 用它指向临时文件，避免改到真实配置）。
    """
    return ENV_FILE


def _current() -> ConfigResponse:
    settings = get_settings()

    return ConfigResponse(
        provider=settings.llm_provider,
        baseUrl=settings.llm_base_url,
        model=resolve_model_name(settings),
        summaryModel=resolve_summary_model_name(settings),
        hasApiKey=settings.llm_api_key.strip() != '',
    )


@router.get('/config', response_model=ConfigResponse)
async def read_config() -> ConfigResponse:
    """当前生效的 LLM 配置。**不含 API Key。**"""
    return _current()


@router.put('/config', response_model=ConfigResponse)
async def update_config(payload: ConfigUpdate) -> ConfigResponse:
    """更新 LLM 配置并写入 `.env`，随后立即生效（无需重启）。

    **未传的字段保持不变。** `apiKey` 传空串同样表示不修改。
    """
    updates: dict[str, str] = {}

    if payload.baseUrl is not None:
        updates['LLM_BASE_URL'] = payload.baseUrl
    if payload.model is not None:
        updates['LLM_MODEL'] = payload.model
    if payload.summaryModel is not None:
        updates['LLM_SUMMARY_MODEL'] = payload.summaryModel
    if payload.apiKey is not None:
        updates['LLM_API_KEY'] = payload.apiKey

    if not updates:
        return _current()

    assert set(updates) <= set(ALLOWED_KEYS), '只允许修改白名单内的键'

    try:
        update_env_file(env_file_path(), updates)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f'写入 .env 失败：{exc}',
        ) from exc

    # 让新值立刻生效：设置与 LLM 客户端都是进程内单例，必须清缓存。
    # 不清的话接口会返回新值、但实际调用仍用旧配置——最难查的那种不一致。
    get_settings.cache_clear()
    reset_llm_client_cache()

    return _current()
