"""`.env.example` 与代码配置的一致性。

## 为什么值得专门测

`.env.example` 是**用户换模型的唯一入口**。加了新配置却忘了写进去，
用户就永远不知道它存在——而这类遗漏**没有任何其他测试能发现**：
代码跑得好好的，只是文档少了东西。

实际发生过：`LLM_SUMMARY_MODEL` 在代码里存在很久，`.env.example` 里
一直没有。用户没法发现「总结可以用另一个模型」这件事。

所以这里做双向校验：
  1. `Settings` 的每个字段，`.env.example` 里必须有
  2. `.env.example` 里每个 `LLM_` 开头的键，`Settings` 里必须有（防拼错）
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.config import Settings

BASE_DIR = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = BASE_DIR / '.env.example'

#: 匹配 `KEY=...` 形式的行（忽略注释行）
KEY_PATTERN = re.compile(r'^([A-Z][A-Z0-9_]*)=', re.MULTILINE)


def documented_keys() -> set[str]:
    return set(KEY_PATTERN.findall(ENV_EXAMPLE.read_text(encoding='utf-8')))


def settings_keys() -> set[str]:
    """`Settings` 的字段名转成环境变量名（pydantic-settings 大小写不敏感）。"""
    return {name.upper() for name in Settings.model_fields}


class TestEnvExample:
    def test_文件存在(self) -> None:
        assert ENV_EXAMPLE.is_file(), '.env.example 缺失——用户没有配置模板可用'

    def test_每个配置项都在模板里(self) -> None:
        """⭐ 这是这个文件存在的理由。

        加了新配置却忘了写进 .env.example，用户就永远不知道它存在。
        """
        missing = sorted(settings_keys() - documented_keys())

        assert not missing, (
            f'这些配置项在代码里有、但 .env.example 里没有：{missing}\n'
            f'用户看不到它们，就等于不存在。请补进 .env.example。'
        )

    def test_模板里没有拼错的键(self) -> None:
        # 只看 LLM_ 前缀——HOST / PORT 之类通用名容易和别的东西撞
        unknown = sorted(
            key for key in documented_keys() if key.startswith('LLM_') and key not in settings_keys()
        )

        assert not unknown, (
            f'.env.example 里有 Settings 不认识的键：{unknown}\n'
            f'多半是拼写错误——填了也不会生效。'
        )

    def test_必填项在模板里是空的(self) -> None:
        """`LLM_API_KEY` 不能带默认值。

        ⚠️ 模板里如果预填了 key，用户复制成 `.env` 后会以为已经配好了。
        """
        text = ENV_EXAMPLE.read_text(encoding='utf-8')

        assert re.search(r'^LLM_API_KEY=\s*$', text, re.MULTILINE), (
            'LLM_API_KEY 在模板里应当留空——预填会让用户以为已经配好了'
        )

    def test_说明了改完要重启(self) -> None:
        """`.env` 只在启动时读一次。不说明的话用户会以为保存就生效。"""
        text = ENV_EXAMPLE.read_text(encoding='utf-8')

        assert '重启' in text, '.env.example 应当说明「改完要重启服务才生效」'

    @pytest.mark.parametrize(
        'key',
        ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_SUMMARY_MODEL', 'LLM_PROVIDER'],
    )
    def test_关键项有说明(self, key: str) -> None:
        """每个关键项附近要有注释——光有键名，用户不知道填什么。"""
        lines = ENV_EXAMPLE.read_text(encoding='utf-8').splitlines()

        for index, line in enumerate(lines):
            if line.startswith(f'{key}='):
                # 往上看 6 行，应当有注释
                above = [item for item in lines[max(0, index - 6) : index] if item.strip()]
                assert any(item.lstrip().startswith('#') for item in above), (
                    f'{key} 上面没有注释说明它是什么'
                )
                return

        pytest.fail(f'.env.example 里找不到 {key}')
