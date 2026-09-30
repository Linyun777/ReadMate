"""占位符保留率实测（真实模型）。

这是整个方案最大的未验证假设（见 `DEVELOPMENT_PLAN.md` 的风险清单）：
**模型是否会原样保留 `<0>...</0>` / `<0/>` 这类占位符？**

本脚本用一组覆盖各种形态的真实用例打到配置的 Provider，统计保留率，
并在失败时打印原文与译文，便于判断是否需要调整占位符格式或 Prompt。

用法（在 server/ 目录下）：

    .venv/bin/python -m scripts.check_placeholder_retention
    .venv/bin/python -m scripts.check_placeholder_retention --style natural

注意：**会发起真实模型请求并产生费用**，因此不作为自动化测试的一部分。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass

from app.clients.factory import create_llm_client
from app.core.config import get_settings
from app.prompts.translation import PROMPT_VERSION
from app.schemas.translation import TranslateRequest, TranslationItem
from app.services.translation_service import TranslationFailedError, TranslationService


@dataclass(frozen=True)
class Case:
    """一个测试用例。`text` 是**分段器实际会产出的**含占位符文本。"""

    label: str
    text: str


#: 用例覆盖的形态。前 12 条转录自 `basic-article.html` 经 Segmenter 处理后的
#: 真实输出（由 `extension/core/segmenter/fixture.test.ts` 断言保证）；
#: 其余是补充的边界形态。
CASES: tuple[Case, ...] = (
    Case("无占位符 · 短标题", "AI Engineering in Practice"),
    Case("无占位符 · 短列表项", "Silent truncation of long inputs"),
    Case(
        "无占位符 · 长段落",
        "Building reliable AI products requires more than prompt engineering. "
        "Teams must treat model behaviour as a system property, measure it "
        "continuously, and design fallbacks for the cases where the model is wrong.",
    ),
    Case("一个成对占位符", "Read the <0>documentation</0> before you start."),
    Case(
        "两个成对占位符",
        "AI engineering is changing <0>software development</0> rapidly. "
        "Read the <1>documentation</1> before you start.",
    ),
    Case("三个成对占位符 · 导航", "<0>Documentation</0> <1>Pricing</1> <2>Blog</2>"),
    Case("一个原子占位符 · 换行", "Line one<0/>Line two"),
    Case(
        "行内代码 · 安装命令",
        "Use <0>npm install</0> to install the package.",
    ),
    Case(
        "⭐ 行内代码 · 函数名（Master 报告的场景）",
        "Call <0>useState()</0> to hold local state in a component.",
    ),
    Case(
        "⭐ 行内代码 · 多个标识符",
        "Run <0>npm install</0> first, then <1>npm run dev</1> to start the server.",
    ),
    Case(
        "行内代码 · 按键",
        "Press <0>Cmd</0> + <1>K</1> to open the command palette.",
    ),
    Case(
        "成对 + 原子混排",
        "Run <0>npm install</0><1/>then start the server.",
    ),
    Case("占位符在句首", "<0>Documentation</0> is the best place to start."),
    Case("占位符在句尾", "Start with the <0>documentation</0>."),
    Case("短表意文字标题", "ニュース"),
    Case(
        "嵌套占位符",
        "<0><1>Bold link text</1></0> appears at the start of this paragraph.",
    ),
    Case(
        "多个原子占位符",
        "First line<0/>Second line<1/>Third line",
    ),
    Case(
        "四个成对占位符",
        "Use <0>npm install</0> first, then read <1>the guide</1>, "
        "and finally run <2>npm start</2> to launch <3>the dev server</3>.",
    ),
    Case(
        "长段落 + 多处 inline",
        "When the <0>model</0> returns <1>invalid JSON</1>, the service retries once. "
        "If it still fails, the <2>batch</2> is marked as failed and the original "
        "text is <3>kept unchanged</3> on the page.",
    ),
    Case(
        "单字符占位符内容",
        "Press <0>Enter</0> to continue.",
    ),
    Case(
        "占位符内容为技术术语",
        "The <0>LLM</0> returns a <1>JSON</1> payload over <2>HTTP</2>.",
    ),
)


async def run_case(service: TranslationService, case: Case, style: str, target: str) -> tuple[bool, str]:
    """执行单个用例。返回 (是否通过, 说明)。"""
    request = TranslateRequest(
        target_language=target,
        style=style,  # type: ignore[arg-type]
        items=[TranslationItem(id="case-001", text=case.text)],
    )

    try:
        response = await service.translate(request)
    except TranslationFailedError as exc:
        return False, exc.reason
    except Exception as exc:  # noqa: BLE001 - 诊断脚本需要看到所有异常
        return False, f"{type(exc).__name__}: {exc}"

    translation = response.items[0].translation
    return True, translation


async def main() -> int:
    parser = argparse.ArgumentParser(description="占位符保留率实测")
    parser.add_argument("--style", default="technical", help="翻译风格，默认 technical")
    parser.add_argument("--target", default="zh-CN", help="目标语言，默认 zh-CN")
    parser.add_argument("--verbose", action="store_true", help="打印全部用例的译文")
    args = parser.parse_args()

    settings = get_settings()
    if settings.llm_provider == "mock":
        print("⚠️  当前 LLM_PROVIDER=mock，测的不是真实模型。请在 server/.env 中配置真实 Provider。")
        return 2

    client = create_llm_client(settings)
    service = TranslationService(client, json_mode=settings.llm_json_mode)

    print("═" * 68)
    print("占位符保留率实测")
    print("═" * 68)
    print(f"  模型         {client.model_name}")
    print(f"  Provider     {settings.llm_base_url}")
    print(f"  Prompt 版本   {PROMPT_VERSION}")
    print(f"  风格 / 目标   {args.style} / {args.target}")
    print(f"  用例数        {len(CASES)}")
    print("─" * 68)

    passed = 0
    failures: list[tuple[Case, str]] = []

    for index, case in enumerate(CASES, start=1):
        ok, detail = await run_case(service, case, args.style, args.target)
        mark = "✓" if ok else "✗"
        print(f"  {mark} [{index:2d}] {case.label}")

        if ok:
            passed += 1
            if args.verbose:
                print(f"         原文: {case.text}")
                print(f"         译文: {detail}")
        else:
            failures.append((case, detail))
            print(f"         原文: {case.text}")
            print(f"         原因: {detail}")

    total = len(CASES)
    rate = passed / total * 100 if total else 0.0

    print("─" * 68)
    print(f"  通过 {passed}/{total} = {rate:.1f}%")

    if failures:
        print()
        print("失败用例汇总：")
        for case, reason in failures:
            print(f"  · {case.label}")
            print(f"    {reason}")

    print("═" * 68)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
