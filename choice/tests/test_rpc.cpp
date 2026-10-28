#include "choice_rpc.hpp"

#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {

class FakeBackend final : public choice_rpc::ChoiceBackend {
 public:
  choice_rpc::Json query(std::string_view function,
                         const choice_rpc::Json& request) override {
    return {{"function", std::string(function)},
            {"fields", choice_rpc::Json::array({"code", "NAME"})},
            {"rows", choice_rpc::Json::array({{{"code", request.at("codes")},
                                                {"NAME", "test"}}})}};
  }
};

void expect(bool condition, std::string_view message) {
  if (!condition) {
    throw std::runtime_error(std::string("test failed: ") + std::string(message));
  }
}

}  // namespace

int main() {
  expect(choice_rpc::is_supported_function("csd"), "csd must be supported");
  expect(choice_rpc::is_supported_function("tradedates"), "tradedates must be supported");
  expect(choice_rpc::is_supported_function("datastatistics"),
         "datastatistics must be supported");
  expect(!choice_rpc::is_supported_function("start"), "start must not be supported");
  expect(choice_rpc::constant_time_equal("token", "token"), "equal tokens must match");
  expect(!choice_rpc::constant_time_equal("token", "Token"),
         "token comparison must be case-sensitive");
  expect(!choice_rpc::constant_time_equal("token", "token-extra"),
         "different-length tokens must not match");
  expect(choice_rpc::normalize_choice_date("2026/8/28") == "2026-08-28",
         "unpadded Choice dates must normalize to ISO format");
  expect(choice_rpc::normalize_choice_date("2026/08/28") == "2026-08-28",
         "padded Choice dates must normalize to ISO format");
  expect(choice_rpc::normalize_choice_date("20260828") == "2026-08-28",
         "compact Choice dates must normalize to ISO format");
  expect(choice_rpc::normalize_choice_date("invalid") == "invalid",
         "invalid Choice dates must remain unchanged");

  FakeBackend backend;
  const auto table = choice_rpc::dispatch(
      backend, "css", choice_rpc::Json({{"codes", "000001.SH"}}));
  expect(table.at("function") == "css", "dispatch must retain the function name");
  expect(table.at("rows").at(0).at("code") == "000001.SH",
         "dispatch must retain the requested code");

  bool rejected = false;
  try {
    (void)choice_rpc::dispatch(backend, "stop", choice_rpc::Json::object());
  } catch (const choice_rpc::RpcError& error) {
    rejected = error.code() == "FUNCTION_NOT_ALLOWED" && error.http_status() == 404;
  }
  expect(rejected, "unsupported functions must be rejected");

  const choice_rpc::RpcError upstream("CHOICE_UPSTREAM", "failed", 503, true, 7);
  const auto error = choice_rpc::error_body(upstream);
  expect(error.at("error").at("code") == "CHOICE_UPSTREAM",
         "error code must be normalized");
  expect(error.at("error").at("retryable") == true,
         "retryable flag must be normalized");
  expect(error.at("error").at("upstreamCode") == 7,
         "upstream error code must be retained");

  std::cout << "choice-rpc contract tests passed\n";
  return 0;
}
