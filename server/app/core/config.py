"""应用配置。

统一通过 pydantic-settings 从环境变量与 `.env` 读取（方案第 21 节）。

安全约束（方案第 52 节原则三）：`llm_api_key` 只在服务端读取，
**任何情况下都不下发给浏览器端**。健康检查等接口也不返回它。
"""

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# 后端目录（server/），用于定位 .env，避免受启动时工作目录影响
BASE_DIR = Path(__file__).resolve().parents[2]

#: 覆盖 `.env` 路径的环境变量。
#:
#: **E2E 必须设它。** 设置页的「保存到服务端」会写 `.env` ——
#: 不隔离的话，跑一次 E2E 就把真实的 Key 和模型配置改了。
#: 与 `USAGE_LEDGER_PATH` 同样的思路。
ENV_FILE_PATH_ENV = 'ENV_FILE_PATH'

#: 实际使用的 `.env`。测试可指向临时文件。
ENV_FILE = Path(os.environ[ENV_FILE_PATH_ENV]) if os.environ.get(ENV_FILE_PATH_ENV) else BASE_DIR / '.env'

#: Prompt 版本号定义在 `app/prompts/translation.py`——它与 Prompt 文本同处一地，
#: 改 Prompt 时不容易忘记递增。

LLMProvider = Literal["openai_compatible", "mock"]

#: mock Provider 的行为模式，仅用于本地开发与测试。
#: ok              正常返回，保留占位符
#: drop-placeholder 丢掉第一个占位符（用于验证占位符校验路径）
#: missing-id      少返回一个条目（用于验证 ID 完整性校验）
#: duplicate-id    重复返回一个条目
#: invalid-json    返回非 JSON 文本
MockMode = Literal["ok", "drop-placeholder", "missing-id", "duplicate-id", "invalid-json"]


class Settings(BaseSettings):
    """服务端配置。字段名对应 .env 中的大写变量（大小写不敏感）。"""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- 服务监听 ----
    host: str = "127.0.0.1"
    port: int = 8000

    # ---- LLM Provider（方案第 71 节）----
    # mock 用于本地开发与 E2E：返回确定性结果，不发起真实模型请求
    llm_provider: LLMProvider = "openai_compatible"

    # ---- 以下三项仅在 llm_provider == "openai_compatible" 时使用 ----
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""

    #: 总结专用的模型。留空则与 `llm_model` 相同。
    #:
    #: 为什么单独配：总结比翻译更吃理解能力（要抓主旨、分辨主次），
    #: 而翻译只是转换。用同一个模型意味着要么翻译过剩、要么总结不足。
    llm_summary_model: str = ""

    llm_timeout: int = 60

    # ---- 生成参数 ----
    #: 翻译是确定性任务，温度固定为 0
    llm_temperature: float = 0.0

    #: 是否请求 Provider 返回 JSON 对象（OpenAI 的 response_format）。
    #: 主流云端 Provider 都支持；若某个兼容接口不支持，可置为 false，
    #: 此时仅靠 Prompt 约束输出格式。
    llm_json_mode: bool = True

    # ---- 测试与本地开发 ----
    #: 仅当 llm_provider == "mock" 时生效，用于模拟各种异常返回
    llm_mock_mode: MockMode = "ok"

    #: mock 流式输出的段间隔（毫秒）。默认 0。
    #: E2E 用它拉开时间窗，以便观察「完成一段就渲染一段」的中间状态。
    llm_mock_stream_delay_ms: int = 0


@lru_cache
def get_settings() -> Settings:
    """进程内单例。测试中如需覆盖，先调用 get_settings.cache_clear()。"""
    return Settings()
