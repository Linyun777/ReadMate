"""v1 端点的共享依赖。

`get_llm_client` 原本定义在 `translate.py` 里。加入解释接口后，
两个端点都需要它——再复制一份迟早会走形（比如只在一处加了配置错误的处理）。
"""

from functools import lru_cache

from fastapi import HTTPException, status

from app.clients.base import LLMClient
from app.clients.factory import (
    ConfigurationError,
    create_llm_client,
    resolve_summary_model_name,
)
from app.core.config import get_settings


@lru_cache(maxsize=1)
def _cached_llm_client() -> LLMClient:
    """进程内复用客户端。

    这样 httpx 的连接池得以保留；每个请求新建客户端会丢掉连接复用。
    `lru_cache` 不缓存异常，因此配置错误时每次请求都会重新尝试并报错。
    """
    return create_llm_client(get_settings())


def get_llm_client() -> LLMClient:
    try:
        return _cached_llm_client()
    except ConfigurationError as exc:
        # 配置缺失属于服务端问题，返回 503 而不是 500 —— 调用方可据此提示用户检查配置
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@lru_cache(maxsize=1)
def _cached_summary_client() -> LLMClient:
    """总结专用客户端。与翻译客户端分开缓存——模型不同，连接池各用各的。"""
    settings = get_settings()
    return create_llm_client(settings, model=resolve_summary_model_name(settings))


def get_summary_llm_client() -> LLMClient:
    try:
        return _cached_summary_client()
    except ConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


def reset_llm_client_cache() -> None:
    """丢弃缓存的客户端（测试用）。"""
    _cached_llm_client.cache_clear()
    _cached_summary_client.cache_clear()
