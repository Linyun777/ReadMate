"""运行时配置接口的测试。

⚠️ **绝不能写到真实的 `server/.env`** ——那里面有真实 Key，
测试跑一次就把它改了。所以每个用例都把 `env_file_path` 指到临时目录。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import config as config_module
from app.core.config import get_settings
from app.main import app

URL = '/api/v1/config'

SAMPLE_ENV = """HOST=127.0.0.1
LLM_PROVIDER=openai_compatible
LLM_API_KEY=sk-test-key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_SUMMARY_MODEL=
"""


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把接口指向临时 `.env`，并让设置从它读。"""
    path = tmp_path / '.env'
    path.write_text(SAMPLE_ENV, encoding='utf-8')

    monkeypatch.setattr(config_module, 'env_file_path', lambda: path)

    # 让 pydantic-settings 也读这个文件
    from pydantic_settings import BaseSettings, SettingsConfigDict

    from app.core import config as config_core

    class ScopedSettings(config_core.Settings):  # type: ignore[misc]
        model_config = SettingsConfigDict(
            env_file=str(path),
            env_file_encoding='utf-8',
            extra='ignore',
        )

    monkeypatch.setattr(config_core, 'Settings', ScopedSettings)
    get_settings.cache_clear()

    yield path

    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


class Test读取:
    def test_返回当前配置(self, env_file: Path, client: TestClient) -> None:
        body = client.get(URL).json()

        assert body['baseUrl'] == 'https://api.deepseek.com/v1'
        assert body['model'] == 'deepseek-chat'
        assert body['provider'] == 'openai_compatible'

    def test_只报有没有_Key_不返回值(self, env_file: Path, client: TestClient) -> None:
        """⭐ 响应里绝不能出现 Key 本身。

        这个接口存在的意义是「不用手工编辑 .env」，
        不是「让浏览器读取密钥」。
        """
        response = client.get(URL)

        assert response.json()['hasApiKey'] is True
        assert 'sk-test-key' not in response.text

    def test_没有_Key_时_hasApiKey_为_false(
        self, env_file: Path, client: TestClient
    ) -> None:
        env_file.write_text('LLM_API_KEY=\nLLM_MODEL=x\n', encoding='utf-8')
        get_settings.cache_clear()

        assert client.get(URL).json()['hasApiKey'] is False


class Test更新:
    def test_改模型(self, env_file: Path, client: TestClient) -> None:
        body = client.put(URL, json={'model': 'deepseek-flash'}).json()

        assert body['model'] == 'deepseek-flash'
        assert 'LLM_MODEL=deepseek-flash' in env_file.read_text(encoding='utf-8')

    def test_改地址(self, env_file: Path, client: TestClient) -> None:
        body = client.put(URL, json={'baseUrl': 'https://open.bigmodel.cn/api/paas/v4'}).json()

        assert body['baseUrl'] == 'https://open.bigmodel.cn/api/paas/v4'

    def test_改_Key(self, env_file: Path, client: TestClient) -> None:
        body = client.put(URL, json={'apiKey': 'sk-new-key'}).json()

        assert body['hasApiKey'] is True
        assert 'LLM_API_KEY=sk-new-key' in env_file.read_text(encoding='utf-8')

    def test_只传要改的字段(self, env_file: Path, client: TestClient) -> None:
        """未传的字段保持不变——这样用户可以只换地址，不必重贴 Key。"""
        client.put(URL, json={'model': 'deepseek-flash'})
        after = env_file.read_text(encoding='utf-8')

        assert 'LLM_API_KEY=sk-test-key' in after
        assert 'LLM_BASE_URL=https://api.deepseek.com/v1' in after

    def test_空_Key_表示不修改(self, env_file: Path, client: TestClient) -> None:
        """⭐ 空输入框不该把密钥清掉。

        「清空密钥」会让服务直接不可用，那不该是一个空输入框的副作用。
        """
        body = client.put(URL, json={'apiKey': ''}).json()

        assert body['hasApiKey'] is True
        assert 'LLM_API_KEY=sk-test-key' in env_file.read_text(encoding='utf-8')

    def test_空请求体不改动(self, env_file: Path, client: TestClient) -> None:
        before = env_file.read_text(encoding='utf-8')

        client.put(URL, json={})

        assert env_file.read_text(encoding='utf-8') == before

    def test_摘要模型可以留空(self, env_file: Path, client: TestClient) -> None:
        """空串是合法值——表示回落到 model。"""
        body = client.put(URL, json={'summaryModel': ''}).json()

        assert body['summaryModel'] == body['model']

    def test_摘要模型单独配置(self, env_file: Path, client: TestClient) -> None:
        body = client.put(URL, json={'summaryModel': 'deepseek-v4-pro'}).json()

        assert body['summaryModel'] == 'deepseek-v4-pro'
        assert body['model'] == 'deepseek-chat'


class Test校验:
    def test_拒绝非_http_地址(self, env_file: Path, client: TestClient) -> None:
        response = client.put(URL, json={'baseUrl': 'ftp://example.com'})

        assert response.status_code == 422

    def test_拒绝空地址(self, env_file: Path, client: TestClient) -> None:
        assert client.put(URL, json={'baseUrl': ''}).status_code == 422

    def test_拒绝空模型名(self, env_file: Path, client: TestClient) -> None:
        assert client.put(URL, json={'model': ''}).status_code == 422

    def test_地址末尾斜杠被去掉(self, env_file: Path, client: TestClient) -> None:
        """避免拼出 `https://x/v1//chat/completions` 这种地址。"""
        body = client.put(URL, json={'baseUrl': 'https://example.com/v1/'}).json()

        assert body['baseUrl'] == 'https://example.com/v1'

    def test_不写坏文件(self, env_file: Path, client: TestClient) -> None:
        """校验失败时文件必须原封不动。"""
        before = env_file.read_text(encoding='utf-8')

        client.put(URL, json={'baseUrl': 'ftp://bad'})

        assert env_file.read_text(encoding='utf-8') == before
