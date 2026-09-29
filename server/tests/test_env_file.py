"""`.env` 更新器的测试。

这个模块直接改用户的配置文件，**写坏了服务就起不来**，
所以边界要测全。
"""

from __future__ import annotations

from pathlib import Path

from app.core.env_file import update_env_file

SAMPLE = """# 伴读 · ReadMate · 本地配置
#
# 这段注释必须保留

HOST=127.0.0.1
PORT=8000

LLM_PROVIDER=openai_compatible

LLM_API_KEY=sk-real-key-should-survive
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

# 总结专用模型（留空则与 LLM_MODEL 相同）
LLM_SUMMARY_MODEL=

LLM_TIMEOUT=120

# LLM_MODEL=这是注释里的，不该被改
"""


def make_env(tmp_path: Path, content: str = SAMPLE) -> Path:
    path = tmp_path / '.env'
    path.write_text(content, encoding='utf-8')
    return path


class Test替换:
    def test_替换已有的键(self, tmp_path: Path) -> None:
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        assert 'LLM_MODEL=deepseek-flash' in path.read_text(encoding='utf-8')

    def test_API_Key_原样保留(self, tmp_path: Path) -> None:
        """改模型绝不能碰到 Key——这是最容易出的事故。"""
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'x', 'LLM_BASE_URL': 'https://y/v1'})

        assert 'LLM_API_KEY=sk-real-key-should-survive' in path.read_text(encoding='utf-8')

    def test_注释与顺序原样保留(self, tmp_path: Path) -> None:
        """用户自己写的注释和排版不能被抹掉。

        「读成字典再整体写回」的实现会把它们全丢掉——那看起来像
        「工具把我的配置搞乱了」。
        """
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})
        after = path.read_text(encoding='utf-8')

        assert '# 这段注释必须保留' in after
        assert '# 总结专用模型（留空则与 LLM_MODEL 相同）' in after
        assert after.startswith('# 伴读 · ReadMate · 本地配置')

    def test_不动注释里的同名键(self, tmp_path: Path) -> None:
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})
        after = path.read_text(encoding='utf-8')

        assert '# LLM_MODEL=这是注释里的，不该被改' in after

    def test_只改指定的键(self, tmp_path: Path) -> None:
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})
        after = path.read_text(encoding='utf-8')

        assert 'LLM_BASE_URL=https://api.deepseek.com/v1' in after
        assert 'LLM_TIMEOUT=120' in after
        assert 'LLM_SUMMARY_MODEL=' in after


class Test追加:
    def test_追加不存在的键(self, tmp_path: Path) -> None:
        path = make_env(tmp_path, 'HOST=127.0.0.1\n')

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        assert path.read_text(encoding='utf-8') == 'HOST=127.0.0.1\n\nLLM_MODEL=deepseek-flash\n'

    def test_文件不存在时创建(self, tmp_path: Path) -> None:
        path = tmp_path / '.env'

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        assert path.read_text(encoding='utf-8') == 'LLM_MODEL=deepseek-flash\n'

    def test_空更新不写入(self, tmp_path: Path) -> None:
        path = make_env(tmp_path)
        before = path.stat().st_mtime_ns

        update_env_file(path, {})

        assert path.stat().st_mtime_ns == before


class Test值格式化:
    def test_普通值不加引号(self, tmp_path: Path) -> None:
        path = make_env(tmp_path, 'LLM_MODEL=old\n')

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        assert path.read_text(encoding='utf-8') == 'LLM_MODEL=deepseek-flash\n'

    def test_含空格的值加引号(self, tmp_path: Path) -> None:
        path = make_env(tmp_path, 'LLM_MODEL=old\n')

        update_env_file(path, {'LLM_MODEL': 'my model'})

        assert path.read_text(encoding='utf-8') == 'LLM_MODEL="my model"\n'

    def test_含井号的值加引号(self, tmp_path: Path) -> None:
        """不加引号的话 `#` 之后会被 dotenv 当成注释。"""
        path = make_env(tmp_path, 'LLM_MODEL=old\n')

        update_env_file(path, {'LLM_MODEL': 'model#v2'})

        assert path.read_text(encoding='utf-8') == 'LLM_MODEL="model#v2"\n'

    def test_空值可以写(self, tmp_path: Path) -> None:
        """`LLM_SUMMARY_MODEL=` 是合法值——表示回落到 LLM_MODEL。"""
        path = make_env(tmp_path, 'LLM_SUMMARY_MODEL=old\n')

        update_env_file(path, {'LLM_SUMMARY_MODEL': ''})

        assert path.read_text(encoding='utf-8') == 'LLM_SUMMARY_MODEL=\n'


class Test原子性:
    def test_不留临时文件(self, tmp_path: Path) -> None:
        path = make_env(tmp_path)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        leftovers = [item.name for item in tmp_path.iterdir() if item.name != '.env']
        assert leftovers == [], f'留下了临时文件：{leftovers}'

    def test_写完能被_pydantic_读出来(self, tmp_path: Path) -> None:
        """端到端：改完的文件必须是合法 dotenv。

        格式化的 bug（少引号、多余空格）单看字符串测不出来，
        只有真拿 dotenv 解析一次才知道。
        """
        from pydantic_settings import BaseSettings, SettingsConfigDict

        class Probe(BaseSettings):
            model_config = SettingsConfigDict(env_file=None, extra='ignore')
            llm_model: str = ''
            llm_summary_model: str = ''

        path = make_env(tmp_path)
        update_env_file(path, {'LLM_MODEL': 'my model#v2', 'LLM_SUMMARY_MODEL': ''})

        class FileProbe(BaseSettings):
            model_config = SettingsConfigDict(env_file=str(path), extra='ignore')
            llm_model: str = ''
            llm_summary_model: str = ''

        probe = FileProbe()

        assert probe.llm_model == 'my model#v2'
        assert probe.llm_summary_model == ''


class Test权限:
    def test_新文件是_600(self, tmp_path: Path) -> None:
        """`.env` 里有 API Key，只该自己可读。"""
        path = tmp_path / '.env'

        update_env_file(path, {'LLM_API_KEY': 'sk-x'})

        assert path.stat().st_mode & 0o777 == 0o600

    def test_原本是_644_的会被收紧(self, tmp_path: Path) -> None:
        """⚠️ 不沿用原权限。

        沿用的话，一个 644 的 `.env` 会一直是 644——
        而这个文件里放的是密钥。
        """
        path = make_env(tmp_path)
        path.chmod(0o644)

        update_env_file(path, {'LLM_MODEL': 'deepseek-flash'})

        assert path.stat().st_mode & 0o777 == 0o600
