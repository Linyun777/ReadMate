"""用量台账（成本可见性）。

## 为什么需要它

Master 问「这些花了多少钱」时，答案是**查不到**——产品从来没记录过用量。
每次调用的 token 数打完日志就没了，重启后更是无迹可寻。

## 设计取舍

**落盘用 JSONL（追加式），不用 JSON。**

JSON 需要「读全文 → 改 → 写回」，进程被杀在写回中途会**整个文件损坏**，
之前的记录全丢。JSONL 只追加，最坏情况是丢最后一行。

**进程内累加 + 每次落盘。**

不用定期刷盘：翻译一页只有几次调用，IO 代价可以忽略；
定期刷盘反而会在崩溃时丢掉最近一段。

**读的时候容忍坏行。**

追加式文件在极端情况下可能出现半行。逐行解析、跳过坏行，
比因为一行坏了就丢掉整个台账好。
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from app.clients.base import Usage

logger = logging.getLogger(__name__)

#: 台账文件。放在 server/ 下，已加入 .gitignore
DEFAULT_LEDGER_PATH = Path(__file__).resolve().parents[2] / '.usage.jsonl'

#: 覆盖台账路径的环境变量。
#:
#: **E2E 必须设它。** E2E 的服务端用 mock Provider，但走的是同一份代码——
#: 不隔离的话，跑一次 E2E 就往真实台账里塞进一堆 mock 用量，
#: 而 mock 的 token 数是按字符数瞎估的，混进去会让真实统计失真。
#: 这类污染很隐蔽：数字看起来正常，只是偏大。
LEDGER_PATH_ENV = 'USAGE_LEDGER_PATH'


@dataclass(frozen=True)
class UsageRecord:
    """一次调用的用量记录。"""

    at: str
    endpoint: str
    model: str
    prompt_tokens: int
    completion_tokens: int

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class UsageSummary:
    """累计统计。"""

    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: 按接口拆分：{endpoint: {calls, prompt_tokens, completion_tokens}}
    by_endpoint: dict[str, dict[str, int]] = field(default_factory=dict)
    #: 按模型拆分
    by_model: dict[str, dict[str, int]] = field(default_factory=dict)
    #: 最早 / 最晚记录时间
    first_at: str | None = None
    last_at: str | None = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class UsageLedger:
    """用量台账：进程内累加，每次追加落盘。"""

    def __init__(self, path: Path | None = None) -> None:
        if path is not None:
            self._path = path
            return

        override = os.environ.get(LEDGER_PATH_ENV, '').strip()
        self._path = Path(override) if override else DEFAULT_LEDGER_PATH

    @property
    def path(self) -> Path:
        return self._path

    def record(self, *, endpoint: str, model: str, usage: Usage | None) -> None:
        """记一次调用。`usage` 为 `None` 时（Provider 未返回）静默跳过。

        跳过而不是记 0：记 0 会让统计看起来「调用过但没花钱」，
        比缺失更容易误导。
        """
        if usage is None:
            return

        record = UsageRecord(
            at=datetime.now(UTC).isoformat(timespec='seconds'),
            endpoint=endpoint,
            model=model,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
        )

        try:
            with self._path.open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(asdict(record), ensure_ascii=False) + '\n')
        except OSError as exc:
            # 台账写不进去不该让翻译失败——它是观测，不是业务
            logger.warning('用量台账写入失败：%s', exc)

    def read_all(self) -> list[UsageRecord]:
        """读出全部记录。坏行跳过。"""
        if not self._path.exists():
            return []

        records: list[UsageRecord] = []

        with self._path.open('r', encoding='utf-8') as handle:
            for line in handle:
                stripped = line.strip()
                if stripped == '':
                    continue

                try:
                    payload = json.loads(stripped)
                    records.append(
                        UsageRecord(
                            at=str(payload['at']),
                            endpoint=str(payload['endpoint']),
                            model=str(payload['model']),
                            prompt_tokens=int(payload['prompt_tokens']),
                            completion_tokens=int(payload['completion_tokens']),
                        )
                    )
                except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                    # 半行 / 字段缺失——跳过，不因为一行坏了丢掉整个台账
                    logger.debug('跳过无法解析的台账行：%s', stripped[:80])
                    continue

        return records

    def summarize(self) -> UsageSummary:
        summary = UsageSummary()

        for record in self.read_all():
            summary.calls += 1
            summary.prompt_tokens += record.prompt_tokens
            summary.completion_tokens += record.completion_tokens

            for bucket, key in (
                (summary.by_endpoint, record.endpoint),
                (summary.by_model, record.model),
            ):
                entry = bucket.setdefault(
                    key, {'calls': 0, 'prompt_tokens': 0, 'completion_tokens': 0}
                )
                entry['calls'] += 1
                entry['prompt_tokens'] += record.prompt_tokens
                entry['completion_tokens'] += record.completion_tokens

            if summary.first_at is None or record.at < summary.first_at:
                summary.first_at = record.at
            if summary.last_at is None or record.at > summary.last_at:
                summary.last_at = record.at

        return summary

    def clear(self) -> int:
        """清空台账，返回清掉的记录数。"""
        count = len(self.read_all())

        if self._path.exists():
            self._path.unlink()

        return count


#: 全局单例——请求处理与端点读的是同一份
_ledger: UsageLedger | None = None


def get_ledger() -> UsageLedger:
    global _ledger
    if _ledger is None:
        _ledger = UsageLedger()
    return _ledger
