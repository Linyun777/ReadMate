"""健康检查接口测试（方案第 16.1 节）。"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["provider"]
    assert body["promptVersion"]


def test_health_never_exposes_api_key() -> None:
    """健康检查不得泄露任何 Key 相关信息（方案第 52 节原则三）。"""
    response = client.get("/api/v1/health")

    lowered = response.text.lower()
    assert "api_key" not in lowered
    assert "apikey" not in lowered
    assert "sk-" not in lowered


def test_root_lists_entrypoints() -> None:
    response = client.get("/")

    assert response.status_code == 200
    body = response.json()
    assert body["health"] == "/api/v1/health"


def test_health_reports_both_models(monkeypatch) -> None:
    """`/health` 要同时报出翻译模型与总结模型。

    为什么要报两个：**「分别指定模型」这件事必须能当场验证**。
    只报一个的话，用户改完 `LLM_SUMMARY_MODEL` 没有任何办法确认它生效了
    ——只能去翻日志或者猜。

    ⚠️ `model` 必须仍是**翻译**用的那个：它参与扩展端的缓存键计算
    （方案第 86.8 节），改成别的会让缓存永远命中不了。
    `summaryModel` 只用于展示，不参与缓存键。
    """
    from app.core.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "translate-model")
    monkeypatch.setenv("LLM_SUMMARY_MODEL", "summary-model")
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    try:
        body = TestClient(app).get("/api/v1/health").json()

        assert body["model"] == "translate-model", "model 必须是翻译用的那个（参与缓存键）"
        assert body["summaryModel"] == "summary-model"
    finally:
        get_settings.cache_clear()


def test_health_summary_model_falls_back(monkeypatch) -> None:
    """`LLM_SUMMARY_MODEL` 留空时回落到 `LLM_MODEL`。"""
    from app.core.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "only-model")
    monkeypatch.setenv("LLM_SUMMARY_MODEL", "")
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_API_KEY", "test-key")

    try:
        body = TestClient(app).get("/api/v1/health").json()

        assert body["model"] == "only-model"
        assert body["summaryModel"] == "only-model"
    finally:
        get_settings.cache_clear()
