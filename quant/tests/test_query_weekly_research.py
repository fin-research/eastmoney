"""单元测试：query_weekly_research.py 的 R2（S3 端点）查询逻辑。"""

import unittest
from datetime import date, datetime
from unittest import mock
from zoneinfo import ZoneInfo

from query_weekly_research import (
    build_article,
    current_week_dates,
    decode_metadata_value,
    fetch_week_articles,
    list_object_keys,
    parse_object_key,
)


class WeekWindowTest(unittest.TestCase):
    def test_current_week_dates_from_friday(self):
        now = datetime(2026, 8, 14, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        dates = current_week_dates(now)
        self.assertEqual(dates[0], date(2026, 8, 10))
        self.assertEqual(dates[-1], date(2026, 8, 16))
        self.assertEqual(len(dates), 7)

    def test_current_week_dates_from_monday(self):
        now = datetime(2026, 8, 10, 8, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertEqual(current_week_dates(now)[0], date(2026, 8, 10))

    def test_current_week_dates_from_sunday(self):
        now = datetime(2026, 8, 16, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        dates = current_week_dates(now)
        self.assertEqual(dates[0], date(2026, 8, 10))
        self.assertEqual(dates[-1], date(2026, 8, 16))


class ObjectKeyTest(unittest.TestCase):
    def test_parse_regular_key(self):
        self.assertEqual(
            parse_object_key("2026-08-11/8月，配置盘与交易盘是否达成一致？.md"),
            ("2026-08-11", "8月，配置盘与交易盘是否达成一致？"),
        )

    def test_parse_ascii_question_mark_key(self):
        self.assertEqual(
            parse_object_key("2026-08-11/如何理解买断国债券放量和地量逆回购共存?.md"),
            ("2026-08-11", "如何理解买断国债券放量和地量逆回购共存?"),
        )

    def test_parse_rejects_bad_keys(self):
        self.assertIsNone(parse_object_key("2026-8-1/标题.md"))
        self.assertIsNone(parse_object_key("标题.md"))
        self.assertIsNone(parse_object_key("2026-08-11/标题.txt"))


class ListObjectKeysTest(unittest.TestCase):
    def test_pagination_follows_continuation_token(self):
        client = mock.Mock()
        client.list_objects_v2.side_effect = [
            {
                "Contents": [{"Key": "2026-08-10/a.md"}, {"Key": "2026-08-10/b.md"}],
                "IsTruncated": True,
                "NextContinuationToken": "next-token",
            },
            {
                "Contents": [{"Key": "2026-08-10/c.md"}],
                "IsTruncated": False,
            },
        ]

        keys = list_object_keys(client, "2026-08-10/")

        self.assertEqual(keys, ["2026-08-10/a.md", "2026-08-10/b.md", "2026-08-10/c.md"])
        self.assertEqual(client.list_objects_v2.call_count, 2)
        self.assertEqual(
            client.list_objects_v2.call_args_list[1].kwargs["ContinuationToken"],
            "next-token",
        )

    def test_limit_caps_results(self):
        client = mock.Mock()
        client.list_objects_v2.return_value = {
            "Contents": [{"Key": f"2026-08-10/{index}.md"} for index in range(5)],
            "IsTruncated": False,
        }
        self.assertEqual(len(list_object_keys(client, "2026-08-10/", limit=3)), 3)


class MetadataDecodeTest(unittest.TestCase):
    def test_decode_rfc2047_encoded_word(self):
        self.assertEqual(
            decode_metadata_value("=?utf-8?Q?=E5=85=B4=E4=B8=9A=E8=AF=81=E5=88=B8?="),
            "兴业证券",
        )

    def test_decode_preserves_plain_text(self):
        self.assertEqual(decode_metadata_value("plain text"), "plain text")
        self.assertEqual(decode_metadata_value(""), "")

    def test_decode_mixed_encoded_and_plain(self):
        value = "=?utf-8?Q?=E4=B8=AD=E4=BF=A1?= note"
        self.assertEqual(decode_metadata_value(value), "中信 note")


class BuildArticleTest(unittest.TestCase):
    def test_build_article_uses_metadata_and_content(self):
        article = build_article(
            "2026-08-14/测试研报.md",
            "# 测试研报\n\n正文内容",
            {
                "published_at": "2026-08-14T01:12:18.000Z",
                "author": "某机构",
                "summary": "摘要内容",
                "importance": "48",
                "keywords": "资金面,利率",
            },
        )
        self.assertEqual(article["title"], "测试研报")
        self.assertEqual(article["date"], "2026-08-14")
        self.assertEqual(article["author"], "某机构")
        self.assertEqual(article["content"], "# 测试研报\n\n正文内容")


class FetchWeekArticlesTest(unittest.TestCase):
    def test_fetch_week_articles_stops_at_limit(self):
        client = mock.Mock()
        with mock.patch(
            "query_weekly_research.list_object_keys",
            return_value=["2026-08-10/a.md", "2026-08-10/b.md", "2026-08-10/c.md"],
        ), mock.patch(
            "query_weekly_research.fetch_object",
            side_effect=[
                ("# a", {"author": "A"}),
                ("# b", {"author": "B"}),
                ("# c", {"author": "C"}),
            ],
        ):
            articles = fetch_week_articles(client, [date(2026, 8, 10)], limit=2)

        self.assertEqual([article["title"] for article in articles], ["a", "b"])
        self.assertEqual(len(articles), 2)

    def test_fetch_week_articles_lists_each_day_prefix(self):
        client = mock.Mock()
        with mock.patch(
            "query_weekly_research.list_object_keys",
            side_effect=lambda _client, prefix: [f"{prefix}a.md"] if prefix == "2026-08-10/" else [],
        ), mock.patch(
            "query_weekly_research.fetch_object",
            return_value=("# a", {}),
        ):
            articles = fetch_week_articles(client, [date(2026, 8, 10), date(2026, 8, 11)], limit=10)

        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]["title"], "a")


if __name__ == "__main__":
    unittest.main()
