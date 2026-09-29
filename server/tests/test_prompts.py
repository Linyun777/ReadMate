"""Prompt 组装测试（方案第 19 节、第 86.3 节）。"""

from typing import Any

from app.prompts.translation import resolve_language_name
from app.schemas.translation import TranslateRequest, TranslationItem
from app.services.prompt_service import PromptService


def make_request(**overrides: Any) -> TranslateRequest:
    payload: dict[str, Any] = {
        "target_language": "zh-CN",
        "style": "technical",
        "items": [TranslationItem(id="block-001", text="Hello <0>world</0>!")],
    }
    payload.update(overrides)
    return TranslateRequest(**payload)


class TestResolveLanguageName:
    def test_常见语言(self) -> None:
        assert resolve_language_name("zh-CN") == "Simplified Chinese"
        assert resolve_language_name("en") == "English"

    def test_大小写不敏感(self) -> None:
        assert resolve_language_name("ZH-cn") == "Simplified Chinese"

    def test_带脚本子标签时回退到主语言(self) -> None:
        assert resolve_language_name("zh-Hans-CN") == "Simplified Chinese"

    def test_未知语言原样返回(self) -> None:
        assert resolve_language_name("xx-YY") == "xx-YY"

    def test_空字符串回退到通用说法(self) -> None:
        assert resolve_language_name("") == "the target language"


class TestSystemPrompt:
    def test_包含占位符规则(self) -> None:
        prompt = PromptService().build_system_prompt(make_request())

        assert "Placeholders" in prompt
        assert "<0> ... </0>" in prompt
        assert "Never translate, renumber, reorder, add, or drop a placeholder." in prompt

    def test_包含风格指令与目标语言(self) -> None:
        prompt = PromptService().build_system_prompt(make_request())

        assert "Style: Technical." in prompt
        assert "Simplified Chinese" in prompt

    def test_目标语言会填进风格指令(self) -> None:
        prompt = PromptService().build_system_prompt(make_request(target_language="en"))

        assert "English" in prompt

    def test_四种风格各有对应指令(self) -> None:
        service = PromptService()

        for style in ("natural", "technical", "academic", "literal"):
            prompt = service.build_system_prompt(make_request(style=style))
            assert f"Style: {style.capitalize()}." in prompt


class TestUserPrompt:
    def test_包含_items_块(self) -> None:
        prompt = PromptService().build_user_prompt(make_request())

        assert "<items>" in prompt
        assert "</items>" in prompt
        assert '"id":"block-001"' in prompt
        assert '"text":"Hello <0>world</0>!"' in prompt

    def test_包含输出格式说明(self) -> None:
        prompt = PromptService().build_user_prompt(make_request())

        assert '"translations"' in prompt

    def test_有上下文时置于最前部(self) -> None:
        prompt = PromptService().build_user_prompt(
            make_request(context="Full article context.", context_id="art-001")
        )

        assert prompt.startswith("<context>")
        assert "Full article context." in prompt

    def test_无上下文时不出现_context_标签(self) -> None:
        assert "<context>" not in PromptService().build_user_prompt(make_request())

    def test_上下文位于_items_之前_以命中_prompt_caching(self) -> None:
        prompt = PromptService().build_user_prompt(
            make_request(context="Article context.", context_id="art-001")
        )

        assert prompt.index("<context>") < prompt.index("<items>")


class TestBuildMessages:
    def test_messages_角色顺序(self) -> None:
        messages = PromptService().build_messages(make_request())

        assert [message.role for message in messages] == ["system", "user"]

    def test_多个条目全部进入_prompt(self) -> None:
        request = make_request(
            items=[
                TranslationItem(id="block-001", text="First paragraph."),
                TranslationItem(id="block-002", text="Second paragraph."),
                TranslationItem(id="block-003", text="Third paragraph."),
            ]
        )

        prompt = PromptService().build_user_prompt(request)

        assert prompt.count('"id":"block-00') == 3
