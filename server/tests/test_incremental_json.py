"""流式 JSON 增量解析测试（方案第 86.9 节）。"""

from app.services.incremental_json import TranslationStreamParser, iter_json_objects


class TestTranslationStreamParser:
    def test_一次性喂入完整文本(self) -> None:
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":[{"id":"a","translation":"1"},{"id":"b","translation":"2"}]}')

        assert [item["id"] for item in items] == ["a", "b"]

    def test_逐字符喂入结果一致(self) -> None:
        text = '{"translations":[{"id":"a","translation":"1"},{"id":"b","translation":"2"}]}'
        parser = TranslationStreamParser()

        items = []
        for char in text:
            items.extend(parser.feed(char))

        assert [item["id"] for item in items] == ["a", "b"]

    def test_元素在闭合时立即产出(self) -> None:
        """核心行为：不必等整个响应结束。"""
        parser = TranslationStreamParser()

        first = parser.feed('{"translations":[{"id":"a","translation":"1"}')
        assert [item["id"] for item in first] == ["a"]

        # 第二个元素还没闭合
        assert parser.feed(',{"id":"b","transla') == []
        assert parser.feed('tion":"2"}') == [{"id": "b", "translation": "2"}]

    def test_空块不产出(self) -> None:
        parser = TranslationStreamParser()

        assert parser.feed("") == []
        assert parser.feed('{"translations":[') == []

    def test_字符串里的花括号不干扰深度计数(self) -> None:
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":[{"id":"a","translation":"{not a brace}"}]}')

        assert items == [{"id": "a", "translation": "{not a brace}"}]

    def test_字符串里的转义引号不干扰(self) -> None:
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":[{"id":"a","translation":"he said \\"hi\\""}]}')

        assert items == [{"id": "a", "translation": 'he said "hi"'}]

    def test_含占位符的译文原样保留(self) -> None:
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":[{"id":"a","translation":"见<0>文档</0>。"}]}')

        assert items == [{"id": "a", "translation": "见<0>文档</0>。"}]

    def test_非法元素被跳过并计数(self) -> None:
        parser = TranslationStreamParser()

        # 尾随逗号 → 该元素不是合法 JSON
        items = parser.feed('{"translations":[{"id":"a",},{"id":"b"}]}')

        assert items == [{"id": "b"}]
        assert parser.malformed == 1

    def test_数组里的非对象元素被忽略(self) -> None:
        """字符串元素不构成条目，也不会被计为解析失败。"""
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":["not an object",{"id":"a"}]}')

        assert items == [{"id": "a"}]
        assert parser.malformed == 0

    def test_reset_清空状态(self) -> None:
        parser = TranslationStreamParser()
        parser.feed('{"translations":[{"id":"a"}')

        parser.reset()

        assert parser.feed('{"translations":[{"id":"b"}]}') == [{"id": "b"}]
        assert parser.malformed == 0

    def test_嵌套更深的元素不被误判(self) -> None:
        """元素内部的嵌套对象属于同一元素，不应被当成新的数组元素。"""
        parser = TranslationStreamParser()

        items = parser.feed('{"translations":[{"id":"a","meta":{"k":"v"}}]}')

        assert items == [{"id": "a", "meta": {"k": "v"}}]


class TestIterJsonObjects:
    def test_一次性解析(self) -> None:
        text = '{"translations":[{"id":"a","translation":"1"},{"id":"b","translation":"2"}]}'

        assert [item["id"] for item in iter_json_objects(text)] == ["a", "b"]
