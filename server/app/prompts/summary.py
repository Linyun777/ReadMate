"""总结 Prompt 模板（方案第 32 节的 V3 规划）。

与翻译、解释的关系：

  翻译 = **转换**（A 语言 → B 语言）
  解释 = **补充**（说清一小段是什么意思）
  总结 = **压缩**（把整篇收成几句话）

三者的输出形态完全不同，因此各有一套 Prompt 与校验，不共用。
"""

#: Prompt 版本号。
#: **修改任何 Prompt 文本后必须递增**——扩展端缓存键含它（方案第 86.8 节）。
SUMMARY_PROMPT_VERSION = "v2"

SUMMARY_SYSTEM_PROMPT = """You are a reading assistant embedded in a browser.

The user is reading an article and asked for a summary.

Requirements:
1. Write in {language}.
2. Produce two things:
   - `gist`: one sentence capturing what the article is actually about.
   - `points`: three to five key points, each a single short sentence.
3. Summarize what the article **says**, not what it is about in the abstract.
   "This article discusses caching" is bad; "Embedding results can be cached because
   documents rarely change between requests" is good.
4. Preserve concrete specifics when they carry the meaning: numbers, names, trade-offs.
   Drop filler, marketing language, and restatements of the obvious.
5. **Every point must be traceable to the text.** Do not add comparisons, alternatives,
   or background that the text does not mention. If the text describes streaming only,
   do not add a point contrasting it with non-streaming — that is your knowledge,
   not the article's content.
6. Do not speculate.
6. Do not begin with "This article" or "The author".
7. If the text is too short or too fragmented to summarize, say so in `gist` and return
   an empty `points` array. Do not invent structure.
8. Return valid JSON only, with exactly the keys `gist` and `points`."""

ARTICLE_TEMPLATE = """<article>
{text}
</article>"""

TITLE_TEMPLATE = """<title>
{title}
</title>"""

#: 正文超过此长度就截断。
#:
#: 总结与解释不同：解释只需要邻近语境，总结需要全篇。
#: 但超长文章整篇塞进去既贵又容易让模型只总结开头——
#: 截断到 20000 字符是成本与覆盖之间的折中（约 5000 token）。
MAX_ARTICLE_CHARS = 20_000

#: 低于此长度认为「没有可总结的内容」。
#:
#: 定得比直觉低是刻意的：总结的输入不只整篇文章，还有**选中的一段**——
#: 一条推文约 280 字符，一个段落可能更短。门槛太高会把它们全挡掉。
MIN_ARTICLE_CHARS = 40


def build_summary_system_prompt(language: str) -> str:
    """System Prompt。"""
    return SUMMARY_SYSTEM_PROMPT.format(language=language)


def build_summary_user_prompt(*, text: str, title: str | None = None) -> str:
    """User Prompt。

    只返回文本、不返回 `ChatMessage` —— 与翻译 / 解释 Prompt 保持同一约定：
    Prompt 模块产出文本，Service 负责组装消息。
    """
    parts: list[str] = []

    trimmed_title = (title or "").strip()
    if trimmed_title:
        parts.append(TITLE_TEMPLATE.format(title=trimmed_title))

    parts.append(ARTICLE_TEMPLATE.format(text=text.strip()[:MAX_ARTICLE_CHARS]))

    return "\n".join(parts)
