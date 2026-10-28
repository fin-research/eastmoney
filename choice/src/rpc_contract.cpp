#include "choice_rpc.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace choice_rpc {

RpcError::RpcError(std::string code, std::string message, int http_status,
                   bool retryable, std::optional<int> upstream_code)
    : std::runtime_error(std::move(message)),
      code_(std::move(code)),
      http_status_(http_status),
      retryable_(retryable),
      upstream_code_(upstream_code) {}

const std::string& RpcError::code() const noexcept { return code_; }
int RpcError::http_status() const noexcept { return http_status_; }
bool RpcError::retryable() const noexcept { return retryable_; }
std::optional<int> RpcError::upstream_code() const noexcept { return upstream_code_; }

bool is_supported_function(std::string_view function) {
  constexpr std::array<std::string_view, 6> kFunctions = {
      "csd", "css", "ctr", "edb", "datastatistics", "tradedates"};
  return std::find(kFunctions.begin(), kFunctions.end(), function) != kFunctions.end();
}

bool constant_time_equal(std::string_view left, std::string_view right) {
  const std::size_t length = std::max(left.size(), right.size());
  std::uint8_t difference = static_cast<std::uint8_t>(left.size() ^ right.size());
  for (std::size_t index = 0; index < length; ++index) {
    const auto left_byte = index < left.size() ? static_cast<std::uint8_t>(left[index]) : 0;
    const auto right_byte = index < right.size() ? static_cast<std::uint8_t>(right[index]) : 0;
    difference = static_cast<std::uint8_t>(difference | (left_byte ^ right_byte));
  }
  return difference == 0;
}

Json dispatch(ChoiceBackend& backend, std::string_view function,
              const Json& request) {
  if (!is_supported_function(function)) {
    throw RpcError("FUNCTION_NOT_ALLOWED", "unsupported Choice function", 404);
  }
  if (!request.is_object()) {
    throw RpcError("INVALID_REQUEST", "request body must be a JSON object", 400);
  }
  return backend.query(function, request);
}

Json error_body(const RpcError& error) {
  Json body = {{"error",
                {{"code", error.code()},
                 {"message", error.what()},
                 {"retryable", error.retryable()}}}};
  if (error.upstream_code().has_value()) {
    body["error"]["upstreamCode"] = *error.upstream_code();
  } else {
    body["error"]["upstreamCode"] = nullptr;
  }
  return body;
}

Json internal_error_body() {
  return {{"error",
           {{"code", "INTERNAL_ERROR"},
            {"message", "internal Choice RPC error"},
            {"retryable", false},
            {"upstreamCode", nullptr}}}};
}

}  // namespace choice_rpc
