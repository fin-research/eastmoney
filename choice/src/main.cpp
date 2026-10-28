#include "choice_rpc.hpp"

#include <arpa/inet.h>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <netinet/in.h>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/socket.h>
#include <unistd.h>

namespace {

using choice_rpc::Json;

constexpr std::size_t kMaximumHeaders = 64 * 1024;
constexpr std::size_t kMaximumBody = 1024 * 1024;
volatile std::sig_atomic_t g_stop_requested = 0;
int g_server_socket = -1;

struct HttpRequest {
  std::string method;
  std::string path;
  std::map<std::string, std::string> headers;
  std::string body;
};

struct HttpResponse {
  int status;
  std::string body;
  std::string request_id;
};

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string lowercase(std::string value) {
  for (char& character : value) {
    if (character >= 'A' && character <= 'Z') {
      character = static_cast<char>(character - 'A' + 'a');
    }
  }
  return value;
}

std::string status_text(int status) {
  switch (status) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 413:
      return "Payload Too Large";
    case 415:
      return "Unsupported Media Type";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

bool send_all(int socket, std::string_view bytes) {
  while (!bytes.empty()) {
    const auto sent = ::send(socket, bytes.data(), bytes.size(), MSG_NOSIGNAL);
    if (sent <= 0) return false;
    bytes.remove_prefix(static_cast<std::size_t>(sent));
  }
  return true;
}

std::optional<HttpRequest> read_request(int socket) {
  std::string buffer;
  buffer.reserve(4096);
  char chunk[4096];
  std::size_t header_end = std::string::npos;
  while ((header_end = buffer.find("\r\n\r\n")) == std::string::npos) {
    const auto received = ::recv(socket, chunk, sizeof(chunk), 0);
    if (received <= 0) return std::nullopt;
    buffer.append(chunk, static_cast<std::size_t>(received));
    if (buffer.size() > kMaximumHeaders) {
      throw choice_rpc::RpcError("HEADERS_TOO_LARGE", "request headers are too large",
                                 413);
    }
  }

  std::istringstream headers_stream(buffer.substr(0, header_end));
  std::string request_line;
  if (!std::getline(headers_stream, request_line)) return std::nullopt;
  request_line = trim(std::move(request_line));
  std::istringstream request_line_stream(request_line);
  HttpRequest request;
  std::string version;
  if (!(request_line_stream >> request.method >> request.path >> version) ||
      version.rfind("HTTP/1.", 0) != 0) {
    throw choice_rpc::RpcError("INVALID_HTTP_REQUEST", "invalid HTTP request line", 400);
  }

  std::string line;
  while (std::getline(headers_stream, line)) {
    line = trim(std::move(line));
    if (line.empty()) continue;
    const auto separator = line.find(':');
    if (separator == std::string::npos) {
      throw choice_rpc::RpcError("INVALID_HTTP_REQUEST", "invalid HTTP header", 400);
    }
    auto name = lowercase(trim(line.substr(0, separator)));
    auto value = trim(line.substr(separator + 1));
    request.headers.insert_or_assign(std::move(name), std::move(value));
  }

  std::size_t content_length = 0;
  if (const auto iterator = request.headers.find("content-length");
      iterator != request.headers.end()) {
    try {
      content_length = std::stoul(iterator->second);
    } catch (const std::exception&) {
      throw choice_rpc::RpcError("INVALID_HTTP_REQUEST", "invalid Content-Length", 400);
    }
  }
  if (content_length > kMaximumBody) {
    throw choice_rpc::RpcError("BODY_TOO_LARGE", "request body is too large", 413);
  }
  if (const auto iterator = request.headers.find("transfer-encoding");
      iterator != request.headers.end() && lowercase(iterator->second) != "identity") {
    throw choice_rpc::RpcError("INVALID_HTTP_REQUEST",
                               "chunked request bodies are not supported", 400);
  }

  const auto body_offset = header_end + 4;
  while (buffer.size() - body_offset < content_length) {
    const auto received = ::recv(socket, chunk, sizeof(chunk), 0);
    if (received <= 0) {
      throw choice_rpc::RpcError("INVALID_HTTP_REQUEST", "incomplete request body", 400);
    }
    buffer.append(chunk, static_cast<std::size_t>(received));
  }
  request.body = buffer.substr(body_offset, content_length);
  const auto query = request.path.find('?');
  if (query != std::string::npos) request.path.resize(query);
  return request;
}

std::string bearer_token(const HttpRequest& request) {
  const auto iterator = request.headers.find("authorization");
  if (iterator == request.headers.end()) return {};
  constexpr std::string_view prefix = "Bearer ";
  if (iterator->second.rfind(prefix, 0) != 0) return {};
  return iterator->second.substr(prefix.size());
}

std::string request_id(const HttpRequest& request) {
  const auto iterator = request.headers.find("x-request-id");
  if (iterator == request.headers.end()) return {};
  auto value = trim(iterator->second).substr(0, 128);
  for (char& character : value) {
    const auto byte = static_cast<unsigned char>(character);
    if (byte < 33 || byte > 126) character = '_';
  }
  return value;
}

HttpResponse dispatch_request(const HttpRequest& request, choice_rpc::ChoiceBackend& backend,
                            std::string_view token) {
  const auto trace_id = request_id(request);
  if (request.method == "GET" && request.path == "/health") {
    return {200,
            Json({{"status", "ok"},
                  {"service", "choice-rpc"},
                  {"version", choice_rpc::kRpcVersion}})
                .dump(),
            trace_id};
  }
  if (request.method != "POST") {
    throw choice_rpc::RpcError("METHOD_NOT_ALLOWED", "only POST is allowed", 405);
  }
  constexpr std::string_view prefix = "/rpc/v1/choice/";
  if (request.path.rfind(prefix, 0) != 0) {
    throw choice_rpc::RpcError("NOT_FOUND", "RPC method not found", 404);
  }
  if (token.empty() ||
      !choice_rpc::constant_time_equal(bearer_token(request), token)) {
    throw choice_rpc::RpcError("UNAUTHORIZED", "invalid RPC token", 401);
  }
  const auto content_type = request.headers.find("content-type");
  if (content_type == request.headers.end() ||
      lowercase(content_type->second).rfind("application/json", 0) != 0) {
    throw choice_rpc::RpcError("UNSUPPORTED_MEDIA_TYPE",
                               "Content-Type must be application/json", 415);
  }

  Json body;
  try {
    body = Json::parse(request.body);
  } catch (const Json::exception&) {
    throw choice_rpc::RpcError("INVALID_JSON", "request body is not valid JSON", 400);
  }
  const auto function = request.path.substr(prefix.size());
  return {200, choice_rpc::dispatch(backend, function, body).dump(), trace_id};
}

// Catch within the parsed request scope so error responses retain its trace.
HttpResponse handle_request(const HttpRequest& request, choice_rpc::ChoiceBackend& backend,
                            std::string_view token) {
  const auto start = std::chrono::steady_clock::now();
  const auto trace_id = request_id(request);
  HttpResponse response;
  Json upstream_code = nullptr;
  try {
    response = dispatch_request(request, backend, token);
  } catch (const choice_rpc::RpcError& error) {
    response = {error.http_status(), choice_rpc::error_body(error).dump(), trace_id};
    if (error.upstream_code().has_value()) upstream_code = *error.upstream_code();
  } catch (const std::exception&) {
    response = {500, choice_rpc::internal_error_body().dump(), trace_id};
  }
  constexpr std::string_view prefix = "/rpc/v1/choice/";
  std::string function = "unknown";
  if (request.path.rfind(prefix, 0) == 0) {
    const auto candidate = request.path.substr(prefix.size());
    if (choice_rpc::is_supported_function(candidate)) function = candidate;
  }
  const auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start).count();
  std::cout << Json({{"event", "choice_rpc_result"}, {"function", function},
                     {"status", response.status}, {"upstreamCode", upstream_code},
                     {"durationMs", duration}, {"requestId", trace_id}}).dump()
            << std::endl;
  return response;
}

void write_response(int socket, const HttpResponse& response) {
  std::ostringstream headers;
  headers << "HTTP/1.1 " << response.status << ' ' << status_text(response.status)
          << "\r\nContent-Type: application/json; charset=utf-8"
          << "\r\nCache-Control: no-store"
          << "\r\nConnection: close"
          << "\r\nX-Choice-Rpc-Version: " << choice_rpc::kRpcVersion;
  if (!response.request_id.empty()) {
    headers << "\r\nX-Request-Id: " << response.request_id;
  }
  headers << "\r\nContent-Length: " << response.body.size() << "\r\n\r\n";
  const auto header_text = headers.str();
  send_all(socket, header_text);
  send_all(socket, response.body);
}

void handle_signal(int) {
  g_stop_requested = 1;
  if (g_server_socket >= 0) ::close(g_server_socket);
}

int listen_port() {
  const char* raw = std::getenv("PORT");
  if (raw == nullptr || *raw == '\0') return 8767;
  const int port = std::stoi(raw);
  if (port < 1 || port > 65535) throw std::runtime_error("PORT is invalid");
  return port;
}

}  // namespace

int main() {
  try {
    const char* raw_token = std::getenv("CHOICE_RPC_TOKEN");
    if (raw_token == nullptr || *raw_token == '\0') {
      throw std::runtime_error("CHOICE_RPC_TOKEN is required");
    }
    const std::string token(raw_token);
    auto backend = choice_rpc::make_dynamic_choice_backend();

    std::signal(SIGTERM, handle_signal);
    std::signal(SIGINT, handle_signal);
    g_server_socket = ::socket(AF_INET, SOCK_STREAM, 0);
    if (g_server_socket < 0) throw std::runtime_error("socket failed");
    int reuse = 1;
    ::setsockopt(g_server_socket, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    // The container uses the Linux host network so the Tunnel connector can
    // reach localhost. Never make this RPC listener reachable from the LAN.
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(static_cast<std::uint16_t>(listen_port()));
    if (::bind(g_server_socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
      throw std::runtime_error("bind failed");
    }
    if (::listen(g_server_socket, 32) < 0) throw std::runtime_error("listen failed");
    std::cout << "{\"event\":\"choice_rpc_started\",\"port\":" << listen_port()
              << "}" << std::endl;

    while (!g_stop_requested) {
      const int client = ::accept(g_server_socket, nullptr, nullptr);
      if (client < 0) {
        if (g_stop_requested) break;
        continue;
      }
      try {
        const auto request = read_request(client);
        if (request.has_value()) {
          write_response(client, handle_request(*request, *backend, token));
        }
      } catch (const choice_rpc::RpcError& error) {
        write_response(client,
                       {error.http_status(), choice_rpc::error_body(error).dump(), {}});
      } catch (const std::exception&) {
        write_response(client, {500, choice_rpc::internal_error_body().dump(), {}});
      }
      ::close(client);
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << Json({{"event", "choice_rpc_fatal"}, {"error", error.what()}}).dump()
              << std::endl;
    return 1;
  }
}
