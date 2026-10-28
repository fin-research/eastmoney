import unittest
import os
from unittest.mock import patch

import httpx

from choice.machine_token import clear_token
from choice.data_api import ChoiceAPIError, _access_headers, css, ctr


class ChoiceDataAPITest(unittest.TestCase):
    @patch(
        "choice.data_api._access_headers",
        return_value={"Authorization": "Bearer fixture"},
    )
    def test_shared_client_keeps_redirects_disabled(self, _headers):
        seen = []

        def handle(request):
            seen.append(request)
            return httpx.Response(302, headers={"Location": "https://other.test/"})

        with httpx.Client(
            transport=httpx.MockTransport(handle), follow_redirects=True
        ) as client:
            result = css("123456.SH", "TEST", "", client=client)
        self.assertEqual(result.error_code, 302)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].url.host, "eastmoney.hasbai.xyz")
        self.assertEqual(seen[0].headers["Authorization"], "Bearer fixture")

    def setUp(self):
        clear_token()
        self.addCleanup(clear_token)
        self.token_request = patch("choice.machine_token.httpx.post")
        self.post = self.token_request.start()
        self.addCleanup(self.token_request.stop)
        self.post.return_value = httpx.Response(
            200,
            json={
                "access_token": "fixture.jwt.signature",
                "expires_in": 3600,
                "token_type": "Bearer",
            },
        )

    @patch.dict(
        os.environ,
        {
            "AUTH0_MACHINE_CLIENT_ID": "fixture-id",
            "AUTH0_MACHINE_CLIENT_SECRET": "fixture-secret",
        },
    )
    @patch("choice.data_api.httpx.get")
    def test_machine_token_is_cached_and_auth_rejection_clears_it_without_replay(
        self, get
    ):
        get.return_value = httpx.Response(
            200, json={"function": "CSS", "fields": [], "rows": []}
        )
        css("123456.SH", "TEST", "")
        css("123456.SH", "TEST", "")
        self.assertEqual(self.post.call_count, 1)
        get.return_value = httpx.Response(403, json={"detail": "forbidden"})
        self.assertEqual(css("123456.SH", "TEST", "").error_code, 403)
        self.assertEqual(get.call_count, 3)
        self.assertEqual(self.post.call_count, 1)
        css("123456.SH", "TEST", "")
        self.assertEqual(self.post.call_count, 2)

    @patch.dict(
        os.environ,
        {
            "AUTH0_MACHINE_CLIENT_ID": "fixture-id",
            "AUTH0_MACHINE_CLIENT_SECRET": "fixture-secret",
        },
    )
    @patch("choice.data_api.httpx.get")
    def test_token_errors_and_redirects_do_not_forward_a_request_or_leak_credentials(
        self, get
    ):
        for response in [
            httpx.Response(302),
            httpx.Response(401),
            httpx.Response(200, json={"access_token": "invalid"}),
        ]:
            self.post.return_value = response
            with self.assertRaises(ChoiceAPIError) as caught:
                css("123456.SH", "TEST", "")
            self.assertNotIn("fixture-secret", str(caught.exception))
            self.assertNotIn("invalid", str(caught.exception))
            get.assert_not_called()

    @patch.dict(
        os.environ,
        {
            "AUTH0_MACHINE_CLIENT_ID": "fixture-id",
            "AUTH0_MACHINE_CLIENT_SECRET": "fixture-secret",
        },
    )
    @patch("choice.data_api.httpx.get")
    def test_service_credentials_are_headers_and_redirects_are_disabled(self, get):
        get.return_value = httpx.Response(
            200, json={"function": "CSS", "fields": [], "rows": []}
        )
        css("123456.SH", "TEST", "")
        args, kwargs = get.call_args
        self.assertNotIn("fixture-secret", args[0])
        self.assertEqual(
            kwargs["headers"]["Authorization"], "Bearer fixture.jwt.signature"
        )
        self.assertNotIn("fixture-secret", str(kwargs))
        self.assertEqual(
            self.post.call_args.args[0], "https://auth.hasbai.xyz/oauth/token"
        )
        self.assertFalse(self.post.call_args.kwargs["follow_redirects"])
        self.assertEqual(
            self.post.call_args.kwargs["json"]["client_secret"], "fixture-secret"
        )
        self.assertFalse(kwargs["follow_redirects"])

    @patch.dict(
        os.environ,
        {
            "AUTH0_MACHINE_CLIENT_ID": "fixture-id",
            "AUTH0_MACHINE_CLIENT_SECRET": "fixture-secret",
        },
    )
    def test_service_credentials_never_go_to_another_origin(self):
        with self.assertRaises(ChoiceAPIError):
            _access_headers("https://other.test/data/choice/css")

    @patch.dict(
        os.environ,
        {"AUTH0_MACHINE_CLIENT_ID": "fixture-id", "AUTH0_MACHINE_CLIENT_SECRET": ""},
    )
    def test_partial_credentials_fail_before_the_request(self):
        with self.assertRaises(ChoiceAPIError):
            _access_headers("https://eastmoney.hasbai.xyz/data/choice/css")

    @patch("choice.data_api.httpx.get")
    def test_auth_failure_cannot_be_treated_as_choice_no_data(self, get):
        get.return_value = httpx.Response(401, json={"detail": "no data"})
        self.assertEqual(css("123456.SH", "TEST", "").error_code, 401)

    @patch("choice.data_api.load_dotenv")
    @patch.dict(os.environ, {}, clear=True)
    @patch("choice.data_api.httpx.get")
    def test_anonymous_and_test_account_credentials_do_not_become_machine_access(
        self, get, _dotenv
    ):
        for identity, credentials in (
            ("anonymous", {}),
            (
                "test@18.cn",
                {
                    "AUTH_TEST_EMAIL": "test@18.cn",
                    "AUTH_TEST_PASSWORD": "unit-placeholder",
                },
            ),
        ):
            with (
                self.subTest(identity=identity),
                patch.dict(os.environ, credentials, clear=True),
            ):
                get.return_value = httpx.Response(
                    401, json={"detail": "login required"}
                )
                result = css("123456.SH", "TEST", "")
                self.assertEqual(result.error_code, 401)
                self.assertEqual(get.call_args.kwargs["headers"], {})
                self.assertFalse(get.call_args.kwargs["follow_redirects"])
                self.assertNotIn("unit-placeholder", str(get.call_args))

    @patch("choice.data_api.httpx.get")
    def test_ctr_returns_validated_table(self, get):
        get.return_value = httpx.Response(
            200,
            json={
                "function": "CTR",
                "fields": ["SECUCODE", "ISSUE_DATE"],
                "rows": [{"SECUCODE": "123456.SH", "ISSUE_DATE": "2026-09-03"}],
            },
        )

        result = ctr("BondIssueDetail", "SECUCODE,ISSUE_DATE", "StartDate=2026-09-03")

        self.assertEqual(result.error_code, 0)
        self.assertEqual(result.fields, ("SECUCODE", "ISSUE_DATE"))
        self.assertEqual(result.rows[0]["SECUCODE"], "123456.SH")
        _, kwargs = get.call_args
        self.assertEqual(kwargs["params"]["reportName"], "BondIssueDetail")

    @patch("choice.data_api.httpx.get")
    def test_css_maps_public_invalid_code_error_to_choice_code(self, get):
        get.return_value = httpx.Response(
            503,
            json={"detail": "invalid stock code"},
        )

        result = css("BAD.SH", "ISSUECREDITSPREAD", "")

        self.assertEqual(result.error_code, 10003008)
        self.assertEqual(result.error_msg, "invalid stock code")

    @patch("choice.data_api.httpx.get")
    def test_ctr_maps_public_no_data_error_to_choice_code(self, get):
        get.return_value = httpx.Response(503, json={"detail": "no data"})

        result = ctr("BondIssueStatistics", "START_DATE", "StartDate=2026-09-04")

        self.assertEqual(result.error_code, 10000009)
        self.assertEqual(result.error_msg, "no data")

    @patch("choice.data_api.httpx.get")
    def test_structured_permission_error_is_not_no_data(self, get):
        get.return_value = httpx.Response(
            503,
            json={
                "detail": "user has no access for this API",
                "error": {"upstreamCode": 10001003},
            },
        )
        result = ctr("BondTradingStatistics", "TOTAL_VOLUME", "")
        self.assertEqual(result.error_code, 10001003)
        self.assertEqual(result.rows, ())
        get.assert_called_once()

    @patch("choice.data_api.httpx.get")
    def test_rejects_schema_drift(self, get):
        get.return_value = httpx.Response(
            200,
            json={"function": "CSS", "fields": ["code"], "rows": "invalid"},
        )

        with self.assertRaisesRegex(ChoiceAPIError, "rows 不符合契约"):
            css("123456.SH", "ISSUECREDITSPREAD", "")


if __name__ == "__main__":
    unittest.main()
