// Compile the existing HTTP handler into this test translation unit. The renamed
// server entrypoint is never called, so tests do not load or log into the SDK.
#include <vector>

#define main choice_rpc_server_main_for_test
#include "../src/main.cpp"
#undef main

namespace {
class CountingBackend final : public choice_rpc::ChoiceBackend {
 public:
  int calls = 0;
  int failure = 0;
  choice_rpc::Json query(std::string_view, const choice_rpc::Json&) override {
    ++calls;
    if (failure == 1) throw choice_rpc::RpcError("CHOICE_UPSTREAM", "sensitive-exception-sentinel", 503, true, 10000009);
    if (failure == 2) throw std::runtime_error("sensitive-exception-sentinel");
    return choice_rpc::Json{{"AVAILABEDATA", "sensitive-quota-sentinel"}};
  }
};
void check(bool condition, std::string_view message) {
  if (!condition) throw std::runtime_error(std::string(message));
}
}  // namespace

int main() {
  CountingBackend backend;
  for (const bool test_account : {false, true}) {
    std::map<std::string, std::string> headers{{"content-type", "application/json"}};
    if (test_account) {
      headers["cookie"] = "CF_Authorization=unit-test-account-session";
      headers["cf-access-authenticated-user-email"] = "test@18.cn";
    }
    const auto health = handle_request({"GET", "/health", headers, {}}, backend, "unit-machine-token");
    check(health.status == 200, "health must remain public");
    for (const auto method : {"csd", "css", "ctr", "edb", "datastatistics", "tradedates"}) {
      const auto denied_response = handle_request({"POST", std::string("/rpc/v1/choice/") + method, headers, "{}"}, backend, "unit-machine-token");
      const bool denied = denied_response.status == 401 && Json::parse(denied_response.body)["error"]["code"] == "UNAUTHORIZED";
      check(denied, "anonymous and website users must not acquire machine RPC access");
    }
  }
  check(backend.calls == 0, "rejected users must never query the SDK");
  const std::map<std::string, std::string> machine_headers{
      {"authorization", "Bearer unit-machine-token"},
      {"content-type", "application/json"}, {"x-request-id", "offline-request"}};
  for (const auto method : {"csd", "css", "ctr", "edb", "datastatistics", "tradedates"}) {
    const auto response = handle_request(
        {"POST", std::string("/rpc/v1/choice/") + method, machine_headers, "{}"},
        backend, "unit-machine-token");
    check(response.status == 200, "machine requests must reach the backend");
    check(response.request_id == "offline-request", "request trace must survive dispatch");
    check(Json::parse(response.body).is_object(), "RPC returns JSON");
  }
  check(backend.calls == 6, "each successful request queries once");
  struct InvalidRequest { std::string method; std::string path; std::string body; int status; };
  for (const auto& invalid : {
      InvalidRequest{"GET", "/rpc/v1/choice/css", "{}", 405},
      InvalidRequest{"POST", "/unknown", "{}", 404},
      InvalidRequest{"POST", "/rpc/v1/choice/css", "broken", 400}}) {
    const auto invalid_response = handle_request({invalid.method, invalid.path, machine_headers, invalid.body},
                                                 backend, "unit-machine-token");
    const bool rejected = invalid_response.status == invalid.status && invalid_response.request_id == "offline-request";
    check(rejected, "invalid HTTP requests must fail before the SDK");
  }
  check(backend.calls == 6, "invalid requests must not query the backend");

  std::ostringstream result_log;
  auto* previous_output = std::cout.rdbuf(result_log.rdbuf());
  std::vector<HttpResponse> traced;
  for (const int failure : {0, 1, 2}) {
    backend.failure = failure;
    traced.push_back(handle_request({"POST", "/rpc/v1/choice/css", machine_headers,
                                    R"({"options":"sensitive-body-sentinel"})"},
                                   backend, "unit-machine-token"));
  }
  traced.push_back(handle_request({"POST", "/rpc/v1/choice/css", machine_headers,
                                  "sensitive-json-sentinel"}, backend, "unit-machine-token"));
  auto unsafe_headers = machine_headers;
  unsafe_headers["x-request-id"] = std::string(130, 'x') + "\r\n";
  traced.push_back(handle_request({"GET", "/sensitive-path-sentinel", unsafe_headers, ""}, backend, "unit-machine-token"));
  unsafe_headers["x-request-id"] = "safe\r\nInjected: x";
  const auto safe_trace = request_id({"GET", "/health", unsafe_headers, ""});
  unsafe_headers["x-request-id"] = "a b\t\x01\xc3\xa9z";
  const auto encoded_trace = request_id({"GET", "/health", unsafe_headers, ""});
  std::cout.rdbuf(previous_output);
  check(backend.calls == 9, "tracing must not add SDK calls");
  check(traced[0].status == 200 && traced[1].status == 503 && traced[2].status == 500 && traced[3].status == 400,
        "success, SDK, internal and JSON errors retain status");
  for (std::size_t i = 0; i < 4; ++i) check(traced[i].request_id == "offline-request", "all parsed responses keep trace");
  check(traced.back().request_id.size() == 128 && safe_trace.find_first_of("\r\n") == std::string::npos,
        "trace is bounded and cannot inject headers");
  check(encoded_trace == "a_b____z" && encoded_trace.size() == 8,
        "spaces, controls and each non-ASCII byte become underscores");
  check(Json::parse(traced[0].body)["AVAILABEDATA"] == "sensitive-quota-sentinel",
        "successful quota-like response remains intact");
  check(Json::parse(traced[1].body) == choice_rpc::error_body(choice_rpc::RpcError("CHOICE_UPSTREAM", "sensitive-exception-sentinel", 503, true, 10000009)), "SDK error body is unchanged");
  check(Json::parse(traced[2].body) == choice_rpc::internal_error_body(), "internal error body is unchanged");
  const auto log = result_log.str();
  for (const auto sensitive : {"sensitive-body-sentinel", "sensitive-json-sentinel", "sensitive-exception-sentinel", "sensitive-path-sentinel", "sensitive-quota-sentinel", "AVAILABEDATA", "unit-machine-token"})
    check(log.find(sensitive) == std::string::npos, "result logs exclude sensitive values");
  std::istringstream log_lines(log);
  std::string log_line;
  int logged = 0;
  while (std::getline(log_lines, log_line)) {
    const auto entry = Json::parse(log_line);
    check(entry.size() == 6 && entry["event"] == "choice_rpc_result", "only safe log fields");
    check(entry["function"] == (logged == 4 ? "unknown" : "css"), "function log allowlist");
    check(entry["status"] == traced[static_cast<std::size_t>(logged)].status, "log status");
    check(entry["requestId"] == traced[static_cast<std::size_t>(logged)].request_id, "log trace");
    check(entry["durationMs"].get<long long>() >= 0, "nonnegative duration");
    check(logged == 1 ? entry["upstreamCode"] == 10000009 : entry["upstreamCode"].is_null(), "safe upstream code");
    ++logged;
  }
  check(logged == 5, "one result log per parsed request");

  int sockets[2];
  check(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair");
  const std::string wire = "POST /rpc/v1/choice/css?trace=1 HTTP/1.1\r\n"
      "Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
  check(send_all(sockets[0], wire), "send request");
  ::shutdown(sockets[0], SHUT_WR);
  const auto parsed = read_request(sockets[1]);
  check(parsed.has_value() && parsed->path == "/rpc/v1/choice/css", "parse HTTP path");
  check(parsed->body == "{}" && parsed->headers.at("content-type") == "application/json",
        "parse body and normalize headers");
  write_response(sockets[1], traced[1]);
  ::shutdown(sockets[1], SHUT_WR);
  std::string received;
  char bytes[1024];
  ssize_t count;
  while ((count = ::recv(sockets[0], bytes, sizeof(bytes), 0)) > 0)
    received.append(bytes, static_cast<std::size_t>(count));
  ::close(sockets[0]);
  ::close(sockets[1]);
  check(received.find("HTTP/1.1 503 Service Unavailable") == 0, "HTTP response status");
  check(received.find("X-Request-Id: offline-request") != std::string::npos, "HTTP trace");
  check(received.ends_with("\r\n\r\n" + traced[1].body), "HTTP error response body");
  std::cout << "choice-rpc offline HTTP and authorization tests passed\n";
}
