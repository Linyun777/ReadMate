"""报告累计用量与估算成本。

## 为什么直接读台账文件而不是调接口

接口需要服务在跑。而「我花了多少钱」这个问题，**往往是在服务已经关掉之后
才想起来的**——那时接口调不通，但文件还在。

所以默认直接读 `.usage.jsonl`。要看服务端视角的结果可以用 `--url`。

## 用法

```bash
# 读本地台账（服务可以没在跑）
.venv/bin/python -m scripts.report_usage

# 带上单价（元 / 百万 token）
.venv/bin/python -m scripts.report_usage --price-in 1 --price-out 4

# 按接口 / 按模型拆分
.venv/bin/python -m scripts.report_usage --price-in 1 --price-out 4 --by endpoint

# 清空（重新开始计数）
.venv/bin/python -m scripts.report_usage --clear
```

⚠️ **单价是外部输入**，会变。本脚本只保证 token 数是实测的，
金额是按你给的价格算出来的。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.core.usage_ledger import DEFAULT_LEDGER_PATH, UsageLedger, UsageSummary


def format_tokens(value: int) -> str:
    return f'{value:,}'


def cost_of(prompt: int, completion: int, price_in: float, price_out: float) -> float:
    return prompt / 1_000_000 * price_in + completion / 1_000_000 * price_out


def print_summary(
    summary: UsageSummary,
    *,
    price_in: float,
    price_out: float,
    title: str,
) -> None:
    print()
    print(f'  {title}')
    print(f'  调用次数        {summary.calls:>10,}')
    print(f'  prompt tokens   {format_tokens(summary.prompt_tokens):>10}')
    print(f'  completion      {format_tokens(summary.completion_tokens):>10}')
    print(f'  合计            {format_tokens(summary.total_tokens):>10}')

    if price_in > 0 or price_out > 0:
        print(
            f'  估算成本        {cost_of(summary.prompt_tokens, summary.completion_tokens, price_in, price_out):>10.4f}'
            f'  （单价 {price_in:g}/{price_out:g} 每百万 token）'
        )


def print_buckets(
    buckets: dict[str, dict[str, int]],
    *,
    price_in: float,
    price_out: float,
    label: str,
) -> None:
    if not buckets:
        return

    print()
    print(f'  按{label}拆分')
    print(f'    {"名称":<16}{"次数":>8}{"prompt":>12}{"completion":>12}{"成本":>12}')

    for key, value in sorted(buckets.items()):
        prompt = value['prompt_tokens']
        completion = value['completion_tokens']
        cost = cost_of(prompt, completion, price_in, price_out) if price_in or price_out else 0.0

        print(
            f'    {key:<16}{value["calls"]:>8}'
            f'{format_tokens(prompt):>12}{format_tokens(completion):>12}'
            f'{cost:>12.4f}'
        )


def main() -> None:
    parser = argparse.ArgumentParser(description='报告累计用量与估算成本')
    parser.add_argument('--ledger', type=Path, default=DEFAULT_LEDGER_PATH, help='台账文件路径')
    parser.add_argument('--price-in', type=float, default=0.0, help='输入单价（每百万 token）')
    parser.add_argument('--price-out', type=float, default=0.0, help='输出单价（每百万 token）')
    parser.add_argument(
        '--by',
        choices=['endpoint', 'model', 'both'],
        default='both',
        help='拆分维度',
    )
    parser.add_argument('--clear', action='store_true', help='清空台账后退出')
    args = parser.parse_args()

    ledger = UsageLedger(args.ledger)

    if args.clear:
        removed = ledger.clear()
        print(f'已清空 {removed} 条记录：{args.ledger}')
        return

    if not args.ledger.exists():
        print(f'台账不存在：{args.ledger}')
        print()
        print('说明：用量是在**这次改动之后**才开始记录的。')
        print('之前的调用没有被记录，无法追溯——那种情况下只能看 Provider 后台的账单。')
        sys.exit(0)

    summary = ledger.summarize()

    print()
    print('═' * 62)
    print('累计用量')
    print('═' * 62)
    print(f'  台账文件        {args.ledger}')
    if summary.first_at:
        print(f'  最早记录        {summary.first_at}')
    if summary.last_at:
        print(f'  最新记录        {summary.last_at}')
    print('─' * 62)

    print_summary(summary, price_in=args.price_in, price_out=args.price_out, title='合计')

    if args.by in ('endpoint', 'both'):
        print_buckets(
            summary.by_endpoint,
            price_in=args.price_in,
            price_out=args.price_out,
            label='接口',
        )
    if args.by in ('model', 'both'):
        print_buckets(
            summary.by_model,
            price_in=args.price_in,
            price_out=args.price_out,
            label='模型',
        )

    print('═' * 62)

    if args.price_in == 0 and args.price_out == 0:
        print()
        print('  提示：没有传单价，因此只报告 token 数。')
        print('  要估算金额：--price-in <输入价> --price-out <输出价>（元 / 百万 token）')


if __name__ == '__main__':
    main()
