"""运行时配置接口的请求 / 响应模型。

## 边界

这个接口只暴露 **LLM 连接信息**，不碰扩展端自己的设置
（目标语言、显示模式那些存在浏览器里，与服务端无关）。

## ⚠️ API Key 只进不出

`ConfigResponse` 里**没有** key 字段，只有一个 `hasApiKey` 布尔值。

理由：这个接口存在的意义是「让用户不用手工编辑 `.env`」，
不是「让浏览器读取密钥」。一旦响应里带上 key，它就必然会被
写进某个地方的日志或缓存——那是铁律 1 想避免的事。
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class ConfigResponse(BaseModel):
    """当前生效的 LLM 配置。**不含 API Key。**"""

    provider: str = Field(description="openai_compatible 或 mock")
    baseUrl: str = Field(description="OpenAI 兼容接口地址")
    model: str = Field(description="翻译 / 解释用的模型")
    summaryModel: str = Field(description="总结 / 笔记用的模型；与 model 相同表示未单独配置")
    hasApiKey: bool = Field(description="是否已配置 API Key。**只报有没有，绝不返回值**")


class ConfigUpdate(BaseModel):
    """更新 LLM 配置。所有字段可选——只传要改的。"""

    baseUrl: str | None = None
    model: str | None = None
    summaryModel: str | None = None
    apiKey: str | None = Field(
        default=None,
        description=(
            "新的 API Key。**留空或不传表示不修改**——"
            "这样用户可以只换地址和模型，不必重新粘贴密钥。"
        ),
    )

    @field_validator('baseUrl')
    @classmethod
    def check_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None

        trimmed = value.strip()
        if trimmed == '':
            raise ValueError('接口地址不能为空')

        if not trimmed.startswith(('http://', 'https://')):
            raise ValueError('接口地址必须以 http:// 或 https:// 开头')

        return trimmed.rstrip('/')

    @field_validator('model')
    @classmethod
    def check_model(cls, value: str | None) -> str | None:
        if value is None:
            return None

        trimmed = value.strip()
        if trimmed == '':
            raise ValueError('模型名不能为空')

        return trimmed

    @field_validator('summaryModel')
    @classmethod
    def check_summary_model(cls, value: str | None) -> str | None:
        if value is None:
            return None

        # 空串是合法值：表示回落到 model
        return value.strip()

    @field_validator('apiKey')
    @classmethod
    def check_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None

        trimmed = value.strip()

        # 空串视为「不修改」——而不是「清空密钥」。
        # 清空密钥会让服务直接不可用，那不该是一个空输入框的副作用。
        return trimmed if trimmed != '' else None
