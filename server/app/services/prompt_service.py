"""Prompt 组装（方案第 70 节：PromptService 负责 Prompt）。"""

import json

from app.clients.base import ChatMessage
from app.prompts.translation import (
    BASE_SYSTEM_PROMPT,
    CONTEXT_CLOSE_TAG,
    CONTEXT_OPEN_TAG,
    ITEMS_CLOSE_TAG,
    ITEMS_OPEN_TAG,
    OUTPUT_FORMAT_INSTRUCTION,
    PLACEHOLDER_RULES,
    STYLE_DIRECTIVES,
    resolve_language_name,
)
from app.schemas.translation import TranslateRequest


class PromptService:
    """把 `TranslateRequest` 组装成 messages。"""

    def build_messages(self, request: TranslateRequest) -> list[ChatMessage]:
        return [
            ChatMessage(role="system", content=self.build_system_prompt(request)),
            ChatMessage(role="user", content=self.build_user_prompt(request)),
        ]

    def build_system_prompt(self, request: TranslateRequest) -> str:
        language = resolve_language_name(request.target_language)
        directive = STYLE_DIRECTIVES[request.style].format(language=language)

        return "\n\n".join(
            [
                BASE_SYSTEM_PROMPT,
                f"Target language: {language} ({request.target_language}).",
                PLACEHOLDER_RULES,
                directive,
            ]
        )

    def build_user_prompt(self, request: TranslateRequest) -> str:
        sections: list[str] = []

        # 共享上下文放在最前部：同一篇文章的多个 Batch 前缀一致，
        # 可命中 Provider 的 prompt caching（方案第 86.6 节）
        if request.context:
            sections.append(f"{CONTEXT_OPEN_TAG}\n{request.context}\n{CONTEXT_CLOSE_TAG}")

        items = [{"id": item.id, "text": item.text} for item in request.items]
        serialized = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        sections.append(f"{ITEMS_OPEN_TAG}\n{serialized}\n{ITEMS_CLOSE_TAG}")

        sections.append(OUTPUT_FORMAT_INSTRUCTION)

        return "\n\n".join(sections)
