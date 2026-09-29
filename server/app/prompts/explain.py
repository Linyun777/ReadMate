"""解释 Prompt 模板（方案第 29、41 节）。

与翻译 Prompt 的区别：

  - 翻译是**转换**（把 A 语言变成 B 语言），要求「不加解释」
  - 解释是**补充**（说清这段文字在这个语境里是什么意思），要求「讲明白」

所以两者的 System Prompt 完全不同，不能复用。

典型场景：读到 `high-agency ownership` 这样的短语，直译没有意义，
需要的是「在这个领域里它指什么」。
"""

#: Prompt 版本号。
#: **修改任何 Prompt 文本后必须递增**——扩展端缓存键含它（方案第 86.8 节）。
EXPLAIN_PROMPT_VERSION = "v1"

EXPLAIN_SYSTEM_PROMPT = """You are a reading assistant embedded in a browser.

The user selected a piece of text while reading a web page and asked for an explanation.

Requirements:
1. Explain what the selected text means **in this specific context**, not a dictionary
   definition. Use the surrounding context when it is provided.
2. If the text is a term of art, explain what it means in that field.
3. If the text is an idiom or a phrase whose literal reading is misleading, say what it
   actually conveys.
4. If the text is a name, a version number, or an identifier that needs no explanation,
   say so briefly instead of inventing meaning.
5. Write in {language}.
6. Be concise: two to four sentences is usually enough. Do not pad.
7. Do not repeat the selected text back verbatim as the first sentence.
8. Do not add a preamble such as "Sure" or "This text means".
9. Plain text only. No markdown headings, no bullet lists, no code fences."""

SELECTION_TEMPLATE = """<selection>
{selection}
</selection>"""

CONTEXT_TEMPLATE = """
<context>
{context}
</context>"""

#: 上下文超过此长度就截断——解释只需要邻近语境，不需要整篇文章
MAX_CONTEXT_CHARS = 1200

#: 选中文本上限。超过说明用户多半是误选，或者想要的是「总结」而非「解释」
MAX_SELECTION_CHARS = 2000


def build_explain_system_prompt(language: str) -> str:
    """System Prompt。"""
    return EXPLAIN_SYSTEM_PROMPT.format(language=language)


def build_explain_user_prompt(*, selection: str, context: str | None) -> str:
    """User Prompt。

    上下文会被截断到 `MAX_CONTEXT_CHARS`：解释只需要**邻近**语境，
    把整篇文章塞进去既费 token 又会让模型跑题。

    只返回文本、不返回 `ChatMessage` —— 与翻译 Prompt 保持同一约定：
    Prompt 模块产出文本，Service 负责组装消息。
    """
    prompt = SELECTION_TEMPLATE.format(selection=selection.strip())

    trimmed = (context or "").strip()
    if trimmed:
        prompt += CONTEXT_TEMPLATE.format(context=trimmed[:MAX_CONTEXT_CHARS])

    return prompt
