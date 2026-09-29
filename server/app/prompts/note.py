"""学习笔记 Prompt（方案第 32 节的 V3 规划）。

## 与「总结」的区别

**总结是压缩，笔记是重组。**

| | 总结 | 笔记 |
| --- | --- | --- |
| 目的 | 快速了解讲了什么 | 日后复习、查阅 |
| 读者 | 现在 | 未来的自己 |
| 长度 | 一句话 + 3–5 条要点 | 结构化、有层级 |
| 内容 | 主旨与要点 | 概念、论点、细节、结论 |

所以两者不共用 Prompt：总结追求「读完就知道大概」，
笔记追求「三个月后回看还能捡起来」。

## 笔记的骨架

```text
positioning   一句话定位：这是什么、讲什么
concepts      核心概念（术语 + 解释）—— 学习笔记最有价值的部分
outline       分节要点，保留文章的组织
takeaways     值得记住的结论
```

`concepts` 单独拎出来是刻意的：读技术文章时，**真正需要反复查的是术语**，
而不是「作者说了什么」。把它们散在要点里，日后就找不到了。
"""

#: Prompt 版本号。
#: **修改任何 Prompt 文本后必须递增**——扩展端缓存键含它（方案第 86.8 节）。
NOTE_PROMPT_VERSION = "v1"

NOTE_SYSTEM_PROMPT = """You are a reading assistant embedded in a browser.

The user just read an article and wants **study notes** they can come back to later.

This is not a summary. A summary tells you what the article was about; notes must let
someone who has forgotten the article pick it back up. Write for the reader's future self.

Requirements:
1. Write in {language}.
2. Return valid JSON with exactly these keys:
   - `positioning`: one sentence saying what this article is and what it covers.
   - `concepts`: the terms a reader would need to look up again. Each is an object with
     `term` and `explanation`. Include a term only if it carries real meaning in this
     article — skip generic words. Use an empty array if there are none.
   - `outline`: the article's structure. Each entry is an object with `heading` and
     `points` (an array of short sentences). Follow the article's own organization
     rather than inventing one.
   - `takeaways`: the conclusions worth remembering, as an array of short sentences.
3. **Every item must be traceable to the text.** Do not add background, comparisons,
   or alternatives the article does not mention — that is your knowledge, not its
   content. Do not speculate.
4. Keep concrete specifics: numbers, names, trade-offs, failure modes. A note that
   drops the specifics is not worth keeping.
5. Prefer the article's own vocabulary for `term`, even when it is in another language.
6. Do not pad. If the article only supports three outline entries, return three.
7. Do not begin any sentence with "This article" or "The author"."""

ARTICLE_TEMPLATE = """<article>
{text}
</article>"""

TITLE_TEMPLATE = """<title>
{title}
</title>"""

#: 正文超过此长度就截断。
#: 与总结同一量级——笔记更长，但输入不需要更多。
MAX_ARTICLE_CHARS = 20_000

#: 低于此长度认为「没有可做笔记的内容」。
MIN_ARTICLE_CHARS = 200


def build_note_system_prompt(language: str) -> str:
    """System Prompt。"""
    return NOTE_SYSTEM_PROMPT.format(language=language)


def build_note_user_prompt(*, text: str, title: str | None = None) -> str:
    """User Prompt。

    只返回文本、不返回 `ChatMessage` —— 与其余 Prompt 保持同一约定：
    Prompt 模块产出文本，Service 负责组装消息。
    """
    parts: list[str] = []

    trimmed_title = (title or "").strip()
    if trimmed_title:
        parts.append(TITLE_TEMPLATE.format(title=trimmed_title))

    parts.append(ARTICLE_TEMPLATE.format(text=text.strip()[:MAX_ARTICLE_CHARS]))

    return "\n".join(parts)
