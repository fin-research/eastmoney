#pragma once

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace choice_rpc {

using Json = nlohmann::json;

inline constexpr std::string_view kRpcVersion = "choice.rpc.v1";

class RpcError final : public std::runtime_error {
 public:
  RpcError(std::string code, std::string message, int http_status,
           bool retryable = false, std::optional<int> upstream_code = std::nullopt);

  [[nodiscard]] const std::string& code() const noexcept;
  [[nodiscard]] int http_status() const noexcept;
  [[nodiscard]] bool retryable() const noexcept;
  [[nodiscard]] std::optional<int> upstream_code() const noexcept;

 private:
  std::string code_;
  int http_status_;
  bool retryable_;
  std::optional<int> upstream_code_;
};

class ChoiceBackend {
 public:
  virtual ~ChoiceBackend() = default;
  virtual Json query(std::string_view function, const Json& request) = 0;
};

std::unique_ptr<ChoiceBackend> make_dynamic_choice_backend();

[[nodiscard]] bool is_supported_function(std::string_view function);
[[nodiscard]] bool constant_time_equal(std::string_view left, std::string_view right);
[[nodiscard]] std::string normalize_choice_date(std::string value);
[[nodiscard]] Json dispatch(ChoiceBackend& backend, std::string_view function,
                            const Json& request);
[[nodiscard]] Json error_body(const RpcError& error);
[[nodiscard]] Json internal_error_body();

}  // namespace choice_rpc
