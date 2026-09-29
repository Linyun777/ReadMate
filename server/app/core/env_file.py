"""`.env` 的安全更新器。

## 为什么需要它

设置页要能改 LLM 配置（URL / 模型 / Key）。改完必须**持久化**——
否则重启服务就丢，用户会以为设置没保存。

持久化的位置只能是 `.env`：它是配置的唯一真相来源，用户也可能手工编辑它。

## 为什么不能简单地重写整个文件

`.env` 里有**用户的 API Key**，还有他自己加的注释、顺序、空行。
一个「读成字典再整体写回」的实现会：
  - 丢掉所有注释
  - 打乱顺序
  - 万一解析有偏差，**可能把 Key 写丢**

所以这里做的是**逐行编辑**：只替换目标键的那一行，其余原样保留。
没找到的键追加到末尾。

## 写入是原子的

先写临时文件再 `os.replace()`。中途失败（磁盘满、进程被杀）不会留下
一个半截的 `.env`——那会让服务起不来。
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

#: 匹配 `KEY=值` 形式的行。允许值里有引号、空格、注释符。
_LINE_PATTERN = re.compile(r'^(?P<key>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>.*)$')


def _format_line(key: str, value: str) -> str:
    """把键值格式化成一行。

    值里含空格或 `#` 时加引号——不加的话 `#` 之后会被 dotenv 当成注释。
    """
    needs_quotes = any(char in value for char in ' #"\'')

    if not needs_quotes:
        return f'{key}={value}'

    escaped = value.replace('\\', '\\\\').replace('"', '\\"')
    return f'{key}="{escaped}"'


def update_env_file(path: Path, updates: dict[str, str]) -> None:
    """就地更新 `.env` 里的若干键，其余内容原样保留。

    不存在的键追加到文件末尾；`updates` 为空时不做任何写入。
    """
    if not updates:
        return

    lines = path.read_text(encoding='utf-8').splitlines() if path.is_file() else []

    remaining = dict(updates)
    output: list[str] = []

    for line in lines:
        match = _LINE_PATTERN.match(line)

        # 只替换未被注释掉的行；注释里的 `# KEY=...` 保持原样
        if match is None or match.group('key') not in remaining:
            output.append(line)
            continue

        key = match.group('key')
        output.append(_format_line(key, remaining.pop(key)))

    # 追加没找到的键
    if remaining:
        if output and output[-1].strip() != '':
            output.append('')

        for key, value in remaining.items():
            output.append(_format_line(key, value))

    content = '\n'.join(output) + '\n'
    _atomic_write(path, content)


def _atomic_write(path: Path, content: str) -> None:
    """先写临时文件再原子替换。"""
    path.parent.mkdir(parents=True, exist_ok=True)

    handle, temp_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f'.{path.name}.',
        suffix='.tmp',
        text=True,
    )

    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            stream.write(content)

        # ⚠️ 固定 600，**不沿用原文件权限**。
        #
        # `.env` 里有 API Key。如果原文件是 644（同机其他用户可读），
        # 沿用就等于把这个问题一直保留下去。这个文件本来就只该自己可读。
        os.chmod(temp_name, 0o600)

        os.replace(temp_name, path)
    except BaseException:
        # 失败时清掉临时文件，别在目录里留垃圾
        Path(temp_name).unlink(missing_ok=True)
        raise
