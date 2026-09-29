"""OpenAI 兼容 Provider（方案第 71 节：V1 只实现这一种）。

覆盖 OpenAI / DeepSeek / OpenRouter / 硅基流动 / 通义兼容接口等
任何实现 `/chat/completions` 的服务。

方案第 86.4 节已决策：**接入云端 API，不做本地模型部署**。
"""

from collections.abc import AsyncIterator
from typing import Any

from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI

from app.clients.base import ChatMessage, Completion, LLMError, Usage


class OpenAICompatibleClient:
    """通过 OpenAI SDK 访问兼容接口。"""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout: int = 60,
        temperature: float = 0.0,
    ) -> None:
        self._model = model
        self._temperature = temperature
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
        )

    @property
    def model_name(self) -> str:
        return self._model

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> str:
        request = self._build_request(messages, json_mode=json_mode)

        try:
            response = await self._client.chat.completions.create(**request)
        except APITimeoutError as exc:
            raise LLMError(f"请求超时：{exc}", retryable=True) from exc
        except APIConnectionError as exc:
            raise LLMError(f"网络错误：{exc}", retryable=True) from exc
        except APIStatusError as exc:
            raise self._status_error(exc) from exc

        if not response.choices:
            raise LLMError("Provider 返回了空的 choices", retryable=True)

        content = response.choices[0].message.content
        if not content:
            raise LLMError("Provider 返回了空内容", retryable=True)

        return content

    async def complete_with_usage(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> Completion:
        """同 `complete`，但一并返回 token 用量。"""
        request = self._build_request(messages, json_mode=json_mode)

        try:
            response = await self._client.chat.completions.create(**request)
        except APITimeoutError as exc:
            raise LLMError(f"请求超时：{exc}", retryable=True) from exc
        except APIConnectionError as exc:
            raise LLMError(f"网络错误：{exc}", retryable=True) from exc
        except APIStatusError as exc:
            raise self._status_error(exc) from exc

        if not response.choices:
            raise LLMError("Provider 返回了空的 choices", retryable=True)

        content = response.choices[0].message.content
        if not content:
            raise LLMError("Provider 返回了空内容", retryable=True)

        return Completion(text=content, usage=self._to_usage(response.usage))

    @staticmethod
    def _to_usage(raw: Any) -> Usage | None:
        """把 SDK 的 usage 转成本项目的 `Usage`。

        兼容接口不一定返回 usage，因此这里是可选的。
        """
        if raw is None:
            return None

        prompt = getattr(raw, "prompt_tokens", None)
        completion = getattr(raw, "completion_tokens", None)
        total = getattr(raw, "total_tokens", None)

        if prompt is None or completion is None:
            return None

        return Usage(
            prompt_tokens=int(prompt),
            completion_tokens=int(completion),
            total_tokens=int(total if total is not None else prompt + completion),
        )

    def complete_stream(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> AsyncIterator[str]:
        """流式取回模型输出，逐段产出文本增量（方案第 86.9 节）。"""
        return self._stream(messages, json_mode=json_mode)

    async def _stream(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool,
    ) -> AsyncIterator[str]:
        request = self._build_request(messages, json_mode=json_mode)
        request["stream"] = True
        # 让 Provider 在流末尾补一个 usage 块——否则流式调用的用量完全不可知
        request["stream_options"] = {"include_usage": True}

        try:
            stream = await self._client.chat.completions.create(**request)
        except APITimeoutError as exc:
            raise LLMError(f"请求超时：{exc}", retryable=True) from exc
        except APIConnectionError as exc:
            raise LLMError(f"网络错误：{exc}", retryable=True) from exc
        except APIStatusError as exc:
            raise self._status_error(exc) from exc

        try:
            async for chunk in stream:
                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except APITimeoutError as exc:
            # 中途失败：调用方已经收到部分内容，只能报错让它决定如何处理
            raise LLMError(f"流式传输中断（超时）：{exc}", retryable=True) from exc
        except APIConnectionError as exc:
            raise LLMError(f"流式传输中断（网络）：{exc}", retryable=True) from exc
        except APIStatusError as exc:
            raise self._status_error(exc) from exc

    def _build_request(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool,
    ) -> dict[str, Any]:
        payload = [{"role": message.role, "content": message.content} for message in messages]

        request: dict[str, Any] = {
            "model": self._model,
            "messages": payload,
            "temperature": self._temperature,
        }
        if json_mode:
            # 主流云端 Provider 均支持；不支持的接口可把 LLM_JSON_MODE 设为 false
            request["response_format"] = {"type": "json_object"}

        return request

    @staticmethod
    def _status_error(exc: APIStatusError) -> LLMError:
        status = exc.status_code
        return LLMError(
            f"Provider 返回 {status}：{exc}",
            retryable=status == 429 or status >= 500,
            status_code=status,
        )
