"""总结专用模型的配置解析。

总结比翻译更吃理解能力，因此允许单独配模型。这组测试守住「回落」行为——
不配 `LLM_SUMMARY_MODEL` 时应当照常能跑，而不是报错。
"""

from app.clients.factory import resolve_model_name, resolve_summary_model_name
from app.core.config import Settings


def make_settings(**overrides: object) -> Settings:
    """构造一个**不读 .env、不读环境变量**的配置。

    必须显式隔离：`Settings` 默认会加载 `.env`，而开发机上
    `LLM_SUMMARY_MODEL` 往往是配好的——不隔离的话，「未配置时回落」
    这类用例会被真实配置悄悄改变结果（写测试时就被咬过一次）。
    """
    base: dict[str, object] = {
        "llm_provider": "openai_compatible",
        "llm_api_key": "k",
        "llm_base_url": "https://example.com/v1",
        "llm_model": "deepseek-chat",
        "llm_summary_model": "",
    }
    base.update(overrides)

    return Settings(_env_file=None, **base)  # type: ignore[arg-type,call-arg]


class TestResolveSummaryModel:
    def test_未单独配置时回落到翻译模型(self) -> None:
        settings = make_settings()

        assert resolve_summary_model_name(settings) == "deepseek-chat"

    def test_单独配置时用配置值(self) -> None:
        settings = make_settings(llm_summary_model="deepseek-flash")

        assert resolve_summary_model_name(settings) == "deepseek-flash"
        # 翻译模型不受影响
        assert resolve_model_name(settings) == "deepseek-chat"

    def test_配置为空白时回落(self) -> None:
        settings = make_settings(llm_summary_model="   ")

        assert resolve_summary_model_name(settings) == "deepseek-chat"

    def test_两端空白被去掉(self) -> None:
        settings = make_settings(llm_summary_model="  deepseek-flash  ")

        assert resolve_summary_model_name(settings) == "deepseek-flash"

    def test_mock_模式下也遵循同一套回落(self) -> None:
        settings = make_settings(llm_provider="mock", llm_model="")

        assert resolve_summary_model_name(settings) == "mock"
