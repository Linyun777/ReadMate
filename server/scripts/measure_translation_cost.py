"""翻译成本与延迟实测（真实模型）。

## 为什么需要它

「翻一页要多少钱、多少秒」这个问题，在写代码时是答不上来的：
Prompt 大小、批次数、模型速度、重试次数都只有跑过才知道。

本脚本把**真实链路**跑一遍并报告实测值：

```text
文本 → 按段落切块 → 按 Batch 预算分组 → 真实 Prompt → 真实模型 → 统计
```

## 与 E2E / 单测的分工

- 单测、E2E：确定性、免费、快 —— 但走 mock，证明不了真实表现
- 本脚本：**真实模型**，报告实测 token / 耗时 / 成本 —— 但花钱、结果不固定

## 用法

```bash
# 用内置 fixture（自动剥掉 HTML 标签）
.venv/bin/python -m scripts.measure_translation_cost

# 用自己的文本
.venv/bin/python -m scripts.measure_translation_cost --file article.txt

# 重复 N 次模拟长页面
.venv/bin/python -m scripts.measure_translation_cost --repeat 5

# 带上单价（元 / 百万 token），输出估算成本
.venv/bin/python -m scripts.measure_translation_cost --price-in 1 --price-out 2
```

⚠️ **会发起真实模型请求并产生费用。**

## 一处刻意的重复

Batch 预算（24000 字符 / 30 条目）与 `extension/core/translator/constants.ts`
是同一套规则的两份实现。之所以不共享：那份是 TypeScript，本脚本是 Python，
跨语言共享需要引入构建步骤——为一个测量脚本不值得。
**改预算规则时两边都要改**（已在 `AGENTS.md` 记录）。
"""

from __future__ import annotations

import argparse
import asyncio
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path

from app.clients.base import ChatMessage, Completion, LLMClient, Usage
from app.clients.factory import create_llm_client
from app.core.config import get_settings
from app.prompts.translation import PROMPT_VERSION
from app.schemas.translation import TranslateRequest, TranslationItem
from app.services.translation_service import TranslationFailedError, TranslationService

#: 与 `extension/core/translator/constants.ts` 保持一致
MAX_BATCH_CHARS = 24_000
MAX_BATCH_ITEMS = 30

#: 单个 Block 的最低字符数——低于此值的段落会被分段器过滤掉，
#: 这里也照做，否则统计出来的条目数会虚高
MIN_BLOCK_CHARS = 2

DEFAULT_FIXTURE = Path(__file__).resolve().parents[2] / 'extension/tests/fixtures/pages/long-article.html'


@dataclass
class CallRecord:
    """一次模型调用的记录。"""

    batch_index: int
    chars: int
    items: int
    seconds: float
    usage: Usage | None


@dataclass
class Measured:
    """整轮测量的累计值。"""

    calls: list[CallRecord] = field(default_factory=list)
    #: 墙钟时间（含并发）。与 \`seconds\` 不同——后者是各次调用耗时之和
    wall_seconds: float = 0.0

    @property
    def prompt_tokens(self) -> int:
        return sum(call.usage.prompt_tokens for call in self.calls if call.usage)

    @property
    def completion_tokens(self) -> int:
        return sum(call.usage.completion_tokens for call in self.calls if call.usage)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def seconds(self) -> float:
        return sum(call.seconds for call in self.calls)

    @property
    def items(self) -> int:
        return sum(call.items for call in self.calls)

    @property
    def chars(self) -> int:
        return sum(call.chars for call in self.calls)


class MeasuringClient:
    """包装真实客户端，记录每次调用的耗时与用量。

    **为什么用包装而不是改 Service**：Service 的职责是编排，
    不该为了「能被测量」而多返回一个 usage 字段——那会把观测需求
    渗进业务代码。包装是纯外部的。
    """

    def __init__(self, inner: LLMClient, measured: Measured) -> None:
        self._inner = inner
        self._measured = measured
        self._batch_index = 0

    @property
    def model_name(self) -> str:
        return self._inner.model_name

    async def complete(self, messages: list[ChatMessage], *, json_mode: bool = False) -> str:
        completion = await self.complete_with_usage(messages, json_mode=json_mode)
        return completion.text

    async def complete_with_usage(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> Completion:
        self._batch_index += 1

        started = time.perf_counter()
        completion = await self._inner.complete_with_usage(messages, json_mode=json_mode)
        elapsed = time.perf_counter() - started

        prompt_chars = sum(len(message.content) for message in messages)
        self._measured.calls.append(
            CallRecord(
                batch_index=self._batch_index,
                chars=prompt_chars,
                items=0,
                seconds=elapsed,
                usage=completion.usage,
            )
        )

        return completion

    def complete_stream(
        self,
        messages: list[ChatMessage],
        *,
        json_mode: bool = False,
    ) -> AsyncIterator[str]:
        return self._inner.complete_stream(messages, json_mode=json_mode)


def extract_text(path: Path) -> tuple[str, str]:
    """读出正文纯文本，返回 (标题, 文本)。

    是 HTML 就剥标签——真实使用中，进模型的永远是分段器产出的纯文本，
    而不是原始 HTML。
    """
    raw = path.read_text(encoding='utf-8')

    title_match = re.search(r'<title[^>]*>(.*?)</title>', raw, re.DOTALL | re.IGNORECASE)
    title = title_match.group(1).strip() if title_match else path.stem

    if '<' not in raw:
        return title, raw

    # 先扔掉 script / style，再剥其余标签
    text = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', raw, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '\n', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)

    return title, text


def split_blocks(text: str) -> list[str]:
    """按段落切块。

    这是对分段器的**近似**——真实分段器按块级元素划分，这里只能按空行。
    用于成本测量足够了：决定成本的是字符总量，不是边界怎么划。
    """
    blocks: list[str] = []

    for line in text.splitlines():
        cleaned = line.strip()
        if len(cleaned) >= MIN_BLOCK_CHARS:
            blocks.append(cleaned)

    return blocks


def plan_batches(blocks: list[str]) -> list[list[tuple[int, str]]]:
    """按 Batch 预算分组。

    与 `extension/core/translator/batching.ts` 的规则一致：字符与条目双上限，
    任一超限就开新批。返回 `[(块序号, 文本), ...]` 的批次列表。
    """
    batches: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    current_chars = 0

    for index, block in enumerate(blocks):
        weight = len(block) + 64  # 与扩展端一致：文本 + id + 固定开销

        if current and (current_chars + weight > MAX_BATCH_CHARS or len(current) >= MAX_BATCH_ITEMS):
            batches.append(current)
            current = []
            current_chars = 0

        current.append((index, block))
        current_chars += weight

    if current:
        batches.append(current)

    return batches


async def measure(
    *,
    text: str,
    language: str,
    style: str,
    repeat: int,
    concurrency: int,
) -> Measured:
    """跑完整链路并返回累计测量值。

    `concurrency` 必须与产品的实际并发一致（默认 3，见 `core/queue`）——
    串行测量的耗时没有参考价值。
    """
    settings = get_settings()
    measured = Measured()
    client = MeasuringClient(create_llm_client(settings), measured)
    service = TranslationService(client, json_mode=settings.llm_json_mode)

    blocks = split_blocks(text) * repeat
    batches = plan_batches(blocks)

    semaphore = asyncio.Semaphore(concurrency)

    async def run_batch(batch: list[tuple[int, str]]) -> None:
        request = TranslateRequest(
            target_language=language,
            style=style,
            items=[TranslationItem(id=f'b{index:04d}', text=block) for index, block in batch],
        )

        async with semaphore:
            try:
                await service.translate(request)
            except TranslationFailedError as exc:
                print(f'  ! 批次失败：{exc.reason}')

            # 记录这一批的条目数（MeasuringClient 拿不到，只有调用方知道）
            if measured.calls:
                measured.calls[-1].items = len(batch)

    started = time.perf_counter()
    await asyncio.gather(*(run_batch(batch) for batch in batches))
    measured.wall_seconds = time.perf_counter() - started

    return measured


def report(measured: Measured, *, price_in: float, price_out: float, model: str) -> None:
    print()
    print('═' * 62)
    print('翻译成本与延迟实测')
    print('═' * 62)
    print(f'  模型          {model}')
    print(f'  Prompt 版本   {PROMPT_VERSION}')
    print(f'  条目数        {measured.items}')
    print(f'  批次数        {len(measured.calls)}')
    print(f'  输入字符      {measured.chars}')
    print('─' * 62)

    if measured.total_tokens == 0:
        print('  Provider 未返回 usage —— 无法报告 token 数')
        print('  （部分兼容接口不返回；换个 Provider 或看服务端日志）')
        return

    print(f'  prompt tokens      {measured.prompt_tokens:>8}')
    print(f'  completion tokens  {measured.completion_tokens:>8}')
    print(f'  合计               {measured.total_tokens:>8}')
    print('─' * 62)
    print(f'  墙钟耗时           {measured.wall_seconds:>8.2f} s  （含并发）')
    print(f'  调用耗时合计       {measured.seconds:>8.2f} s  （各次相加）')

    if measured.calls:
        print(f'  单批平均           {measured.seconds / len(measured.calls):>8.2f} s')
    if measured.total_tokens:
        print(f'  每千 token 耗时    {measured.seconds / measured.total_tokens * 1000:>8.2f} s')

    if price_in > 0 or price_out > 0:
        cost = (
            measured.prompt_tokens / 1_000_000 * price_in
            + measured.completion_tokens / 1_000_000 * price_out
        )
        print('─' * 62)
        print(f'  估算成本           {cost:>8.4f} （单价 {price_in}/{price_out} 每百万 token）')
        if measured.items:
            print(f'  每段成本           {cost / measured.items:>8.6f}')

    print('═' * 62)


def main() -> None:
    parser = argparse.ArgumentParser(description='翻译成本与延迟实测（真实模型）')
    parser.add_argument('--file', type=Path, default=DEFAULT_FIXTURE, help='要翻译的文本或 HTML')
    parser.add_argument('--language', default='zh-CN', help='目标语言')
    parser.add_argument('--style', default='natural', help='翻译风格')
    parser.add_argument('--repeat', type=int, default=1, help='重复次数（模拟长页面）')
    parser.add_argument(
        '--concurrency',
        type=int,
        default=3,
        help='并发批次数，默认 3（与产品一致，见 core/queue）',
    )
    parser.add_argument('--price-in', type=float, default=0.0, help='输入单价（每百万 token）')
    parser.add_argument('--price-out', type=float, default=0.0, help='输出单价（每百万 token）')
    args = parser.parse_args()

    if not args.file.exists():
        raise SystemExit(f'找不到文件：{args.file}')

    title, text = extract_text(args.file)
    blocks = split_blocks(text)

    print(f'  文件     {args.file}')
    print(f'  标题     {title}')
    print(f'  段落数   {len(blocks)}（重复 {args.repeat} 次 → {len(blocks) * args.repeat}）')
    print(f'  目标语言 {args.language} / 风格 {args.style} / 并发 {args.concurrency}')
    print('  开始请求真实模型…')

    measured = asyncio.run(
        measure(
            text=text,
            language=args.language,
            style=args.style,
            repeat=args.repeat,
            concurrency=args.concurrency,
        )
    )

    report(
        measured,
        price_in=args.price_in,
        price_out=args.price_out,
        model=get_settings().llm_model,
    )


if __name__ == '__main__':
    main()
