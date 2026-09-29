"""用量台账测试。"""

import json
from pathlib import Path
from fastapi.testclient import TestClient

from app.clients.base import Usage
from app.core.usage_ledger import UsageLedger
from app.main import app


def make_ledger(temp_dir: Path) -> UsageLedger:
    return UsageLedger(temp_dir / '.usage.jsonl')


class TestRecording:
    def test_记一次调用(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        ledger.record(
            endpoint='translate',
            model='deepseek-chat',
            usage=Usage(prompt_tokens=100, completion_tokens=50, total_tokens=150),
        )

        records = ledger.read_all()
        assert len(records) == 1
        assert records[0].endpoint == 'translate'
        assert records[0].prompt_tokens == 100
        assert records[0].total_tokens == 150

    def test_usage_为_None_时跳过(self, temp_dir: Path) -> None:
        """Provider 没返回 usage 时**不记 0**。

        记 0 会让统计看起来「调用过但没花钱」——比缺失更容易误导。
        """
        ledger = make_ledger(temp_dir)

        ledger.record(endpoint='translate', model='m', usage=None)

        assert ledger.read_all() == []
        assert not ledger.path.exists()

    def test_追加不覆盖(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        for index in range(3):
            ledger.record(
                endpoint='translate',
                model='m',
                usage=Usage(prompt_tokens=index, completion_tokens=0, total_tokens=index),
            )

        assert len(ledger.read_all()) == 3


class TestReading:
    def test_文件不存在时返回空(self, temp_dir: Path) -> None:
        assert make_ledger(temp_dir).read_all() == []

    def test_坏行被跳过而不是让整个台账失效(self, temp_dir: Path) -> None:
        """追加式文件在极端情况下会出现半行。

        因为一行坏了就丢掉全部记录，是最糟的处理方式。
        """
        path = temp_dir / '.usage.jsonl'
        good = {
            'at': '2026-09-27T10:00:00+00:00',
            'endpoint': 'translate',
            'model': 'm',
            'prompt_tokens': 10,
            'completion_tokens': 5,
        }

        path.write_text(
            json.dumps(good) + '\n'
            '{"at": "2026-09-27T10:00:01+00:00", "endpoint": "trans\n'  # 半行
            'not json at all\n'
            '\n'  # 空行
            + json.dumps({**good, 'prompt_tokens': 20}) + '\n',
            encoding='utf-8',
        )

        records = UsageLedger(path).read_all()

        assert len(records) == 2
        assert [record.prompt_tokens for record in records] == [10, 20]

    def test_字段缺失的行被跳过(self, temp_dir: Path) -> None:
        path = temp_dir / '.usage.jsonl'
        path.write_text('{"at": "2026-09-27T10:00:00+00:00"}\n', encoding='utf-8')

        assert UsageLedger(path).read_all() == []


class TestSummary:
    def test_累计与拆分(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        ledger.record(
            endpoint='translate',
            model='deepseek-chat',
            usage=Usage(prompt_tokens=100, completion_tokens=50, total_tokens=150),
        )
        ledger.record(
            endpoint='translate',
            model='deepseek-chat',
            usage=Usage(prompt_tokens=200, completion_tokens=80, total_tokens=280),
        )
        ledger.record(
            endpoint='explain',
            model='deepseek-chat',
            usage=Usage(prompt_tokens=30, completion_tokens=10, total_tokens=40),
        )

        summary = ledger.summarize()

        assert summary.calls == 3
        assert summary.prompt_tokens == 330
        assert summary.completion_tokens == 140
        assert summary.total_tokens == 470

        assert summary.by_endpoint['translate']['calls'] == 2
        assert summary.by_endpoint['translate']['prompt_tokens'] == 300
        assert summary.by_endpoint['explain']['calls'] == 1

    def test_按模型拆分(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        ledger.record(
            endpoint='translate',
            model='model-a',
            usage=Usage(prompt_tokens=10, completion_tokens=1, total_tokens=11),
        )
        ledger.record(
            endpoint='translate',
            model='model-b',
            usage=Usage(prompt_tokens=20, completion_tokens=2, total_tokens=22),
        )

        summary = ledger.summarize()

        assert set(summary.by_model) == {'model-a', 'model-b'}
        assert summary.by_model['model-b']['prompt_tokens'] == 20

    def test_时间范围(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        ledger.record(
            endpoint='translate',
            model='m',
            usage=Usage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )

        summary = ledger.summarize()

        assert summary.first_at is not None
        assert summary.first_at == summary.last_at

    def test_空台账(self, temp_dir: Path) -> None:
        summary = make_ledger(temp_dir).summarize()

        assert summary.calls == 0
        assert summary.total_tokens == 0
        assert summary.by_endpoint == {}


class TestClear:
    def test_清空返回条数(self, temp_dir: Path) -> None:
        ledger = make_ledger(temp_dir)

        for _ in range(4):
            ledger.record(
                endpoint='translate',
                model='m',
                usage=Usage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            )

        assert ledger.clear() == 4
        assert ledger.read_all() == []

    def test_清空空台账返回_0(self, temp_dir: Path) -> None:
        assert make_ledger(temp_dir).clear() == 0


class TestUsageEndpoint:
    def test_返回累计用量(self) -> None:
        from app.core.usage_ledger import get_ledger

        get_ledger().record(
            endpoint='translate',
            model='deepseek-chat',
            usage=Usage(prompt_tokens=100, completion_tokens=50, total_tokens=150),
        )

        response = TestClient(app).get('/api/v1/usage')

        assert response.status_code == 200
        body = response.json()
        assert body['calls'] == 1
        assert body['prompt_tokens'] == 100
        assert body['completion_tokens'] == 50
        assert body['total_tokens'] == 150
        assert body['by_endpoint']['translate']['calls'] == 1
        assert body['by_model']['deepseek-chat']['prompt_tokens'] == 100

    def test_不含金额字段(self) -> None:
        """接口只报告 token——金额是外部输入，写进 API 会随调价变成假话。"""
        body = TestClient(app).get('/api/v1/usage').json()

        assert 'cost' not in body
        assert not any('price' in key or 'cost' in key for key in body)

    def test_可清空(self) -> None:
        from app.core.usage_ledger import get_ledger

        get_ledger().record(
            endpoint='translate',
            model='m',
            usage=Usage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )

        client = TestClient(app)
        assert client.delete('/api/v1/usage').json()['cleared'] == 1
        assert client.get('/api/v1/usage').json()['calls'] == 0
