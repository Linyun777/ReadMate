"""按配置创建 LLM 客户端（方案第 71 节的 Provider 抽象）。"""

from app.clients.base import LLMClient
from app.clients.mock import MockLLMClient
from app.clients.openai_compatible import OpenAICompatibleClient
from app.core.config import Settings


class ConfigurationError(Exception):
    """配置缺失或不合法。应在启动时就暴露，而不是等到第一次请求。"""


def resolve_model_name(settings: Settings) -> str:
    """当前生效的模型名。

    mock 模式下 `LLM_MODEL` 常常没配，此时回落为 `"mock"`。

    单独抽出来是因为**两处必须给出同一个值**：翻译响应里的 `model`，
    与 `/health` 返回的 `model`——后者参与扩展端缓存键计算
    （方案第 86.8 节），两者不一致会导致缓存永远命中不了。
    """
    return settings.llm_model.strip() or "mock"


def resolve_summary_model_name(settings: Settings) -> str:
    """总结用的模型名。未单独配置时回落到翻译模型。

    回落而不是报错：不配 `LLM_SUMMARY_MODEL` 应当照常能跑，
    只是总结与翻译用同一个模型。
    """
    return settings.llm_summary_model.strip() or resolve_model_name(settings)


def create_llm_client(settings: Settings, *, model: str | None = None) -> LLMClient:
    """按 `LLM_PROVIDER` 构造客户端。

    `mock` 用于本地开发与 E2E——返回确定性结果，不发起任何网络请求。

    `model` 可覆盖模型名（如总结用 `LLM_SUMMARY_MODEL`）。不传则用
    `LLM_MODEL`。Provider 与其余参数不变——换模型不该意味着换 Provider。
    """
    resolved = model.strip() if model else ""

    if settings.llm_provider == "mock":
        return MockLLMClient(
            mode=settings.llm_mock_mode,
            model=resolved or resolve_model_name(settings),
            stream_delay_ms=settings.llm_mock_stream_delay_ms,
        )

    missing = [
        name
        for name, value in (
            ("LLM_API_KEY", settings.llm_api_key),
            ("LLM_BASE_URL", settings.llm_base_url),
            ("LLM_MODEL", settings.llm_model),
        )
        if not value.strip()
    ]
    if missing:
        raise ConfigurationError(
            "LLM_PROVIDER=openai_compatible 时以下配置不能为空：" + "、".join(missing)
        )

    return OpenAICompatibleClient(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=resolved or settings.llm_model,
        timeout=settings.llm_timeout,
        temperature=settings.llm_temperature,
    )
