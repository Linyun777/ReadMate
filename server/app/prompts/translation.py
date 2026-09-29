"""翻译 Prompt 模板。

依据方案第 19 节（基础 System Prompt）与第 86.3 节（四种风格的 Style Directive）。

**与方案第 86.3 节的一处差异**：方案里的风格指令把目标语言写死为 Chinese。
由于 `target_language` 是请求字段，这里改为占位符 `{language}`，
由 `resolve_language_name()` 填入。这是必要的泛化——否则把目标语言设成英文时
Prompt 会自相矛盾。
"""

from app.schemas.translation import TranslationStyle

#: Prompt 版本号（方案第 69 节）。
#: **修改任何 Prompt 文本后必须递增**，以触发扩展端缓存失效。
PROMPT_VERSION = "v2"

BASE_SYSTEM_PROMPT = """You are a professional translation engine.

Translate the provided text into the target language.

Requirements:
1. Preserve the original meaning.
2. Use natural, idiomatic language instead of literal machine translation.
3. Preserve technical terms such as AI, LLM, Agent, RAG, API when appropriate.
4. Do not translate source code, URLs, product names, model names, or identifiers
   unless necessary.
5. Do not add explanations, notes, or commentary.
6. Do not remove information.
7. Preserve each input item's ID exactly.
8. Return valid JSON only."""

PLACEHOLDER_RULES = """Placeholders

Each item's text may contain placeholders that mark document structure:

  <0> ... </0>   an inline element wraps the enclosed text
                 (link, bold, emphasis, inline code, keyboard key)
  <0/>           an atomic element kept as-is (line break, image)

Rules for placeholders:
1. Reproduce every placeholder exactly as given, including the angle brackets and
   the index number.
2. Never translate, renumber, reorder, add, or drop a placeholder.
3. Never add spaces or punctuation around a placeholder.
4. Translate only the text between placeholders. A placeholder is not a word.
   Exception: text wrapped by a **code** placeholder is an identifier such as
   `useState()` or `npm install`. Keep it exactly as written — do not translate,
   split, or reformat it — but do place it where the target sentence needs it.
5. Paired placeholders must stay paired: if the input has <0> ... </0>, so must the
   output.
6. If the input has no placeholders, the output must have none either."""

STYLE_DIRECTIVES: dict[TranslationStyle, str] = {
    "natural": (
        "Style: Natural.\n"
        "Produce idiomatic, readable {language}. Prioritize fluency over literal\n"
        "correspondence. Restructure sentences when the target word order differs\n"
        "from the source."
    ),
    "technical": (
        "Style: Technical.\n"
        "Preserve technical terms in their original form when they are standard in\n"
        "the field (for example LLM, RAG, Agent, embedding, token). Do not translate\n"
        "product names, model names, library names, or identifiers. Prefer\n"
        "established {language} translations where they exist."
    ),
    "academic": (
        "Style: Academic.\n"
        "Use formal, precise academic {language}. Prefer complete sentences and\n"
        "explicit logical connectors. Avoid colloquialisms. Preserve the hedging\n"
        "and epistemic modality of the source."
    ),
    "literal": (
        "Style: Literal.\n"
        "Stay close to the source sentence structure and word order. Minimize\n"
        "interpretation and paraphrase. Do not merge or split sentences."
    ),
}

#: 常见目标语言的英文名。用于把 `target_language` 填进风格指令。
LANGUAGE_NAMES: dict[str, str] = {
    "zh": "Simplified Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "zh-hk": "Traditional Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "pt": "Portuguese",
    "ru": "Russian",
    "it": "Italian",
    "ar": "Arabic",
    "hi": "Hindi",
    "nl": "Dutch",
    "pl": "Polish",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "th": "Thai",
}


#: 用户消息中的分节标记。
#: 用显式标签而不是裸 JSON——模型对带分隔符的块处理更稳，
#: Mock 客户端也据此解析待翻译条目。
CONTEXT_OPEN_TAG = "<context>"
CONTEXT_CLOSE_TAG = "</context>"
ITEMS_OPEN_TAG = "<items>"
ITEMS_CLOSE_TAG = "</items>"

#: 期望的输出结构说明，附在用户消息末尾。
OUTPUT_FORMAT_INSTRUCTION = (
    'Return a JSON object with exactly one key "translations", whose value is an\n'
    "array with one entry per input item, in the same order:\n"
    "\n"
    '{"translations":[{"id":"<same id as input>","translation":"<translated text>"}]}\n'
    "\n"
    "Do not add any other keys. Do not wrap the JSON in markdown fences."
)


def resolve_language_name(code: str) -> str:
    """把语言代码转成可读的英文名；未知代码原样返回。"""
    normalized = code.strip().lower()
    if not normalized:
        return "the target language"

    if normalized in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[normalized]

    # 尝试只用主语言标签匹配，如 "zh-Hans-CN" -> "zh"
    primary = normalized.split("-", 1)[0]
    if primary in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[primary]

    return code.strip()
