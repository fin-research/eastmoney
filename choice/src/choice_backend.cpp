#include "choice_rpc.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace choice_rpc {
namespace {

enum VariantType : int {
  kNull = 0,
  kChar = 1,
  kByte = 2,
  kBool = 3,
  kShort = 4,
  kUnsignedShort = 5,
  kInt = 6,
  kUnsignedInt = 7,
  kInt64 = 8,
  kUnsignedInt64 = 9,
  kFloat = 10,
  kDouble = 11,
  kByteArray = 12,
  kAsciiString = 13,
  kUnicodeString = 14,
};

union SafeUnion {
  char char_value;
  bool bool_value;
  short short_value;
  unsigned short unsigned_short_value;
  int int_value;
  unsigned int unsigned_int_value;
  long long int64_value;
  unsigned long long unsigned_int64_value;
  float float_value;
  double double_value;
};

struct EqChar {
  char* value;
  unsigned int size;
};

struct EqCharArray {
  EqChar* values;
  unsigned int size;
};

struct EqVariant {
  int type;
  SafeUnion scalar;
  EqChar text;
};

struct EqVariantArray {
  EqVariant* values;
  unsigned int size;
};

struct EqData {
  EqCharArray codes;
  EqCharArray indicators;
  EqCharArray dates;
  EqVariantArray values;
};

struct EqCtrData {
  int rows;
  int columns;
  EqCharArray indicators;
  EqVariantArray values;
};

struct EqLoginInfo {
  char username[255];
  char password[255];
};

using LogCallback = int (*)(const char*);
using StartFunction = int (*)(EqLoginInfo*, const char*, LogCallback);
using ManualActivateFunction = int (*)(EqLoginInfo*, const char*, LogCallback);
using StopFunction = int (*)();
using SetServerListDirectoryFunction = void (*)(const char*);
using GetErrorStringFunction = const char* (*)(int, int);
using ReleaseDataFunction = int (*)(void*);
using CsdFunction = int (*)(const char*, const char*, const char*, const char*,
                            const char*, EqData**);
using CssFunction = int (*)(const char*, const char*, const char*, EqData**);
using TradedatesFunction = int (*)(const char*, const char*, const char*, EqData**);
using CtrFunction = int (*)(const char*, const char*, const char*, EqCtrData**);
using EdbFunction = int (*)(const char*, const char*, EqData**);
using DataStatisticsFunction = int (*)(const char*, const char*, const char*,
                                       EqCtrData**);

constexpr std::size_t kMaximumArrayItems = 2'000'000;
constexpr int kExpiredUserInfoCode = 10001020;

std::string environment(std::string_view name, std::string_view fallback = {}) {
  const char* value = std::getenv(std::string(name).c_str());
  if (value == nullptr || *value == '\0') return std::string(fallback);
  return value;
}

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::string uppercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}

std::vector<std::string> split_csv(std::string_view value) {
  std::vector<std::string> items;
  std::stringstream stream{std::string(value)};
  std::string item;
  while (std::getline(stream, item, ',')) {
    item = trim(std::move(item));
    if (!item.empty()) items.push_back(std::move(item));
  }
  return items;
}

std::string join_csv(const std::vector<std::string>& items) {
  std::string result;
  for (const auto& item : items) {
    if (!result.empty()) result.push_back(',');
    result.append(item);
  }
  return result;
}

std::string option_key(std::string_view item) {
  const auto separator = item.find('=');
  return uppercase(trim(std::string(item.substr(0, separator))));
}

std::string normalized_options(std::string_view options,
                               const std::set<std::string>& reserved = {}) {
  std::vector<std::string> items;
  for (auto item : split_csv(options)) {
    const auto key = option_key(item);
    if (key == "ISPANDAS" || reserved.contains(key)) continue;
    items.push_back(std::move(item));
  }
  items.emplace_back("Ispandas=0");
  return join_csv(items);
}

std::string required_string(const Json& request, std::string_view name,
                            std::size_t maximum_length = 4096) {
  const auto iterator = request.find(std::string(name));
  if (iterator == request.end() || !iterator->is_string()) {
    throw RpcError("INVALID_REQUEST", std::string(name) + " must be a string", 400);
  }
  auto value = trim(iterator->get<std::string>());
  if (value.empty()) {
    throw RpcError("INVALID_REQUEST", std::string(name) + " must not be empty", 400);
  }
  if (value.size() > maximum_length) {
    throw RpcError("INVALID_REQUEST", std::string(name) + " is too long", 400);
  }
  return value;
}

std::string optional_string(const Json& request, std::string_view name,
                            std::size_t maximum_length = 4096) {
  const auto iterator = request.find(std::string(name));
  if (iterator == request.end() || iterator->is_null()) return {};
  if (!iterator->is_string()) {
    throw RpcError("INVALID_REQUEST", std::string(name) + " must be a string", 400);
  }
  auto value = trim(iterator->get<std::string>());
  if (value.size() > maximum_length) {
    throw RpcError("INVALID_REQUEST", std::string(name) + " is too long", 400);
  }
  return value;
}

std::string normalize_date(std::string value) {
  value = trim(std::move(value));
  const auto digits_only = [](std::string_view part) {
    return !part.empty() &&
           std::all_of(part.begin(), part.end(), [](unsigned char character) {
             return std::isdigit(character) != 0;
           });
  };
  if (value.size() == 8 && digits_only(value)) {
    return value.substr(0, 4) + "-" + value.substr(4, 2) + "-" + value.substr(6, 2);
  }

  const auto first_separator = value.find_first_of("/-");
  const auto second_separator = first_separator == std::string::npos
                                    ? std::string::npos
                                    : value.find_first_of("/-", first_separator + 1);
  if (first_separator != 4 || second_separator == std::string::npos ||
      value.find_first_of("/-", second_separator + 1) != std::string::npos ||
      value[first_separator] != value[second_separator]) {
    return value;
  }
  const auto year = std::string_view(value).substr(0, first_separator);
  const auto month = std::string_view(value).substr(
      first_separator + 1, second_separator - first_separator - 1);
  const auto day = std::string_view(value).substr(second_separator + 1);
  if (!digits_only(year) || !digits_only(month) || !digits_only(day) ||
      month.size() > 2 || day.size() > 2) {
    return value;
  }
  const int month_number = std::stoi(std::string(month));
  const int day_number = std::stoi(std::string(day));
  if (month_number < 1 || month_number > 12 || day_number < 1 || day_number > 31) {
    return value;
  }
  const auto padded_month = month.size() == 1 ? "0" + std::string(month) : std::string(month);
  const auto padded_day = day.size() == 1 ? "0" + std::string(day) : std::string(day);
  value = std::string(year) + "-" + padded_month + "-" + padded_day;
  return value;
}

std::size_t checked_size(unsigned int value, std::string_view label) {
  if (value > kMaximumArrayItems) {
    throw RpcError("CHOICE_INVALID_RESPONSE",
                   std::string(label) + " exceeds safety limit", 502);
  }
  return value;
}

std::string eq_string(const EqChar& value) {
  if (value.value == nullptr) return {};
  return std::string(value.value);
}

std::vector<std::string> eq_strings(const EqCharArray& array) {
  const auto size = checked_size(array.size, "Choice string array");
  if (size > 0 && array.values == nullptr) {
    throw RpcError("CHOICE_INVALID_RESPONSE", "Choice string array is null", 502);
  }
  std::vector<std::string> result;
  result.reserve(size);
  for (std::size_t index = 0; index < size; ++index) {
    result.push_back(eq_string(array.values[index]));
  }
  return result;
}

double rounded(double value) {
  return std::round(value * 1'000'000.0) / 1'000'000.0;
}

Json variant_json(const EqVariant& variant) {
  switch (variant.type) {
    case kNull:
    case kByte:
    case kByteArray:
      return nullptr;
    case kChar:
      return std::string(1, variant.scalar.char_value);
    case kBool:
      return variant.scalar.bool_value;
    case kShort:
      return variant.scalar.short_value;
    case kUnsignedShort:
      return variant.scalar.unsigned_short_value;
    case kInt:
      return variant.scalar.int_value;
    case kUnsignedInt:
      return variant.scalar.unsigned_int_value;
    case kInt64:
      return variant.scalar.int64_value;
    case kUnsignedInt64:
      return variant.scalar.unsigned_int64_value;
    case kFloat:
      return rounded(variant.scalar.float_value);
    case kDouble:
      return rounded(variant.scalar.double_value);
    case kAsciiString:
    case kUnicodeString:
      return eq_string(variant.text);
    default:
      return nullptr;
  }
}

std::vector<std::string> normalized_fields(const EqCharArray& raw_fields,
                                           std::string_view requested) {
  auto source = eq_strings(raw_fields);
  if (source.empty()) source = split_csv(requested);
  std::map<std::string, int> counts;
  std::vector<std::string> fields;
  fields.reserve(source.size());
  for (std::size_t index = 0; index < source.size(); ++index) {
    auto base = uppercase(trim(source[index]));
    if (base.empty()) base = "FIELD_" + std::to_string(index + 1);
    const int count = ++counts[base];
    fields.push_back(count == 1 ? base : base + "_" + std::to_string(count));
  }
  return fields;
}

std::vector<std::string> normalized_codes(const EqCharArray& raw_codes,
                                          std::string_view requested) {
  auto source = eq_strings(raw_codes);
  if (source.empty()) source = split_csv(requested);
  std::set<std::string> seen;
  std::vector<std::string> codes;
  for (auto code : source) {
    code = uppercase(trim(std::move(code)));
    if (!code.empty() && seen.insert(code).second) codes.push_back(std::move(code));
  }
  return codes;
}

Json sequence_table(std::string_view function, const EqData& data,
                    std::string_view requested_codes,
                    std::string_view requested_indicators, bool omit_empty_rows) {
  const auto codes = normalized_codes(data.codes, requested_codes);
  const auto fields = normalized_fields(data.indicators, requested_indicators);
  auto dates = eq_strings(data.dates);
  for (auto& date : dates) date = normalize_date(std::move(date));

  const auto raw_code_count = checked_size(data.codes.size, "Choice codes");
  const auto indicator_count = checked_size(data.indicators.size, "Choice indicators");
  const auto date_count = checked_size(data.dates.size, "Choice dates");
  const auto value_count = checked_size(data.values.size, "Choice values");
  if (value_count > 0 && data.values.values == nullptr) {
    throw RpcError("CHOICE_INVALID_RESPONSE", "Choice value array is null", 502);
  }
  const bool valid_shape = value_count == raw_code_count * indicator_count * date_count;

  Json output_fields = Json::array({"code", "date"});
  for (const auto& field : fields) output_fields.push_back(field);
  Json rows = Json::array();
  for (std::size_t code_index = 0; code_index < codes.size(); ++code_index) {
    for (std::size_t date_index = 0; date_index < dates.size(); ++date_index) {
      Json row = {{"code", codes[code_index]}, {"date", dates[date_index]}};
      bool has_value = false;
      for (std::size_t indicator_index = 0; indicator_index < fields.size();
           ++indicator_index) {
        Json value = nullptr;
        const auto value_index = raw_code_count * indicator_count * date_index +
                                 indicator_count * code_index + indicator_index;
        if (valid_shape && value_index < value_count) {
          value = variant_json(data.values.values[value_index]);
        }
        if (!value.is_null()) has_value = true;
        row[fields[indicator_index]] = std::move(value);
      }
      if (!omit_empty_rows || has_value) rows.push_back(std::move(row));
    }
  }
  if (omit_empty_rows) {
    std::sort(rows.begin(), rows.end(), [](const Json& left, const Json& right) {
      return std::pair{left.at("code").get<std::string>(),
                       left.at("date").get<std::string>()} <
             std::pair{right.at("code").get<std::string>(),
                       right.at("date").get<std::string>()};
    });
  }
  return {{"function", uppercase(std::string(function))},
          {"fields", std::move(output_fields)},
          {"rows", std::move(rows)}};
}

Json cross_section_table(const EqData& data, std::string_view requested_codes,
                         std::string_view requested_indicators) {
  const auto codes = normalized_codes(data.codes, requested_codes);
  const auto fields = normalized_fields(data.indicators, requested_indicators);
  const auto raw_code_count = checked_size(data.codes.size, "Choice codes");
  const auto indicator_count = checked_size(data.indicators.size, "Choice indicators");
  const auto date_count = checked_size(data.dates.size, "Choice dates");
  const auto value_count = checked_size(data.values.size, "Choice values");
  if (value_count > 0 && data.values.values == nullptr) {
    throw RpcError("CHOICE_INVALID_RESPONSE", "Choice value array is null", 502);
  }
  const bool valid_shape = value_count == raw_code_count * indicator_count * date_count;

  Json output_fields = Json::array({"code"});
  for (const auto& field : fields) output_fields.push_back(field);
  Json rows = Json::array();
  for (std::size_t code_index = 0; code_index < codes.size(); ++code_index) {
    Json row = {{"code", codes[code_index]}};
    for (std::size_t indicator_index = 0; indicator_index < fields.size();
         ++indicator_index) {
      Json value = nullptr;
      const auto value_index = indicator_count * code_index + indicator_index;
      if (valid_shape && value_index < value_count) {
        value = variant_json(data.values.values[value_index]);
      }
      row[fields[indicator_index]] = std::move(value);
    }
    rows.push_back(std::move(row));
  }
  return {{"function", "CSS"},
          {"fields", std::move(output_fields)},
          {"rows", std::move(rows)}};
}

Json record_table(std::string_view function, const EqCtrData& data,
                  std::string_view requested_indicators) {
  if (data.rows < 0 || data.columns < 0) {
    throw RpcError("CHOICE_INVALID_RESPONSE", "Choice table dimensions are invalid", 502);
  }
  const auto row_count = checked_size(static_cast<unsigned int>(data.rows), "Choice rows");
  const auto column_count =
      checked_size(static_cast<unsigned int>(data.columns), "Choice columns");
  const auto value_count = checked_size(data.values.size, "Choice values");
  if (value_count > 0 && data.values.values == nullptr) {
    throw RpcError("CHOICE_INVALID_RESPONSE", "Choice value array is null", 502);
  }
  auto fields = normalized_fields(data.indicators, requested_indicators);
  if (fields.size() < column_count) {
    for (std::size_t index = fields.size(); index < column_count; ++index) {
      fields.push_back("FIELD_" + std::to_string(index + 1));
    }
  }

  Json rows = Json::array();
  for (std::size_t row_index = 0; row_index < row_count; ++row_index) {
    Json row = Json::object();
    for (std::size_t column_index = 0; column_index < column_count; ++column_index) {
      const auto value_index = row_index * column_count + column_index;
      row[fields[column_index]] = value_index < value_count
                                      ? variant_json(data.values.values[value_index])
                                      : Json(nullptr);
    }
    rows.push_back(std::move(row));
  }
  return {{"function", uppercase(std::string(function))},
          {"fields", fields},
          {"rows", std::move(rows)}};
}

int discard_log(const char*) { return 1; }

template <typename Function>
Function symbol(void* library, const char* name) {
  dlerror();
  void* address = dlsym(library, name);
  if (const char* error = dlerror(); error != nullptr) {
    throw RpcError("CHOICE_SDK_UNAVAILABLE",
                   std::string("missing Choice SDK symbol: ") + name, 503);
  }
  return reinterpret_cast<Function>(address);
}

class DynamicChoiceBackend final : public ChoiceBackend {
 public:
  DynamicChoiceBackend() {
    library_path_ = environment("CHOICE_SDK_LIBRARY",
                                "/opt/choice/lib/libEMQuantAPIx64.so");
    library_ = dlopen(library_path_.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (library_ == nullptr) {
      throw RpcError("CHOICE_SDK_UNAVAILABLE", "unable to load Choice C++ SDK", 503);
    }
    try {
      start_ = symbol<StartFunction>(library_, "start");
      manual_activate_ =
          symbol<ManualActivateFunction>(library_, "manualactivate");
      stop_ = symbol<StopFunction>(library_, "stop");
      set_server_list_directory_ =
          symbol<SetServerListDirectoryFunction>(library_, "setserverlistdir");
      error_string_ = symbol<GetErrorStringFunction>(library_, "geterrstring");
      release_data_ = symbol<ReleaseDataFunction>(library_, "releasedata");
      csd_ = symbol<CsdFunction>(library_, "csd");
      css_ = symbol<CssFunction>(library_, "css");
      tradedates_ = symbol<TradedatesFunction>(library_, "tradedates");
      ctr_ = symbol<CtrFunction>(library_, "ctr");
      edb_ = symbol<EdbFunction>(library_, "edb");
      data_statistics_ =
          symbol<DataStatisticsFunction>(library_, "datastatistics");
    } catch (...) {
      dlclose(library_);
      library_ = nullptr;
      throw;
    }
  }

  ~DynamicChoiceBackend() override {
    std::lock_guard lock(mutex_);
    if (logged_in_ && stop_ != nullptr) stop_();
    if (library_ != nullptr) dlclose(library_);
  }

  Json query(std::string_view function, const Json& request) override {
    std::lock_guard lock(mutex_);
    ensure_login();
    if (function == "csd") return query_csd(request);
    if (function == "css") return query_css(request);
    if (function == "tradedates") return query_tradedates(request);
    if (function == "ctr") return query_ctr(request);
    if (function == "edb") return query_edb(request);
    if (function == "datastatistics") return query_data_statistics(request);
    throw RpcError("FUNCTION_NOT_ALLOWED", "unsupported Choice function", 404);
  }

 private:
  void ensure_login() {
    if (logged_in_) return;
    const auto auth = environment("CHOICE_AUTH");
    if (auth.empty()) {
      throw RpcError("CHOICE_AUTH_MISSING", "CHOICE_AUTH is required", 503);
    }

    std::string username;
    std::string password;
    std::vector<std::string> options;
    for (auto item : split_csv(auth)) {
      const auto separator = item.find('=');
      if (separator == std::string::npos) {
        options.push_back(std::move(item));
        continue;
      }
      const auto key = uppercase(trim(item.substr(0, separator)));
      const auto value = trim(item.substr(separator + 1));
      if (key == "USERNAME") {
        username = value;
      } else if (key == "PASSWORD") {
        password = value;
      } else {
        options.push_back(std::move(item));
      }
    }
    if (username.empty() || password.empty() || username.size() >= 255 ||
        password.size() >= 255) {
      throw RpcError("CHOICE_AUTH_INVALID",
                     "CHOICE_AUTH must contain valid USERNAME and PASSWORD", 503);
    }

    EqLoginInfo login{};
    std::memcpy(login.username, username.data(), username.size());
    std::memcpy(login.password, password.data(), password.size());
    const auto directory = std::filesystem::path(library_path_).parent_path().string();
    set_server_list_directory_(directory.c_str());
    const auto option_text = join_csv(options);
    int code = start_(&login, option_text.c_str(), discard_log);
    if (code == kExpiredUserInfoCode) {
      const int activation_code =
          manual_activate_(&login, option_text.c_str(), discard_log);
      if (activation_code != 0) {
        std::fill(username.begin(), username.end(), '\0');
        std::fill(password.begin(), password.end(), '\0');
        throw upstream_error(activation_code, "Choice account reactivation failed",
                             false);
      }
      code = start_(&login, option_text.c_str(), discard_log);
    }
    std::fill(username.begin(), username.end(), '\0');
    std::fill(password.begin(), password.end(), '\0');
    if (code != 0) throw upstream_error(code, "Choice login failed", false);
    logged_in_ = true;
  }

  RpcError upstream_error(int code, std::string_view fallback, bool retryable) const {
    const char* raw = error_string_ != nullptr ? error_string_(code, 1) : nullptr;
    const std::string message = raw != nullptr && *raw != '\0' ? raw : std::string(fallback);
    return RpcError("CHOICE_UPSTREAM", message, 503, retryable, code);
  }

  Json query_csd(const Json& request) {
    const auto codes = required_string(request, "codes");
    const auto indicators = required_string(request, "indicators");
    const auto start_date = required_string(request, "startDate", 10);
    const auto end_date = required_string(request, "endDate", 10);
    const auto options = normalized_options(optional_string(request, "options"));
    EqData* data = nullptr;
    const int code = csd_(codes.c_str(), indicators.c_str(), start_date.c_str(),
                          end_date.c_str(), options.c_str(), &data);
    if (code != 0) throw upstream_error(code, "Choice csd failed", true);
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE", "Choice csd returned no data", 502);
    }
    try {
      auto table = sequence_table("CSD", *data, codes, indicators, false);
      release_data_(data);
      return table;
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  Json query_css(const Json& request) {
    const auto codes = required_string(request, "codes");
    const auto indicators = required_string(request, "indicators");
    const auto options = normalized_options(optional_string(request, "options"));
    EqData* data = nullptr;
    const int code = css_(codes.c_str(), indicators.c_str(), options.c_str(), &data);
    if (code != 0) throw upstream_error(code, "Choice css failed", true);
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE", "Choice css returned no data", 502);
    }
    try {
      auto table = cross_section_table(*data, codes, indicators);
      release_data_(data);
      return table;
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  Json query_tradedates(const Json& request) {
    const auto start_date = required_string(request, "startDate", 10);
    const auto end_date = required_string(request, "endDate", 10);
    const auto options = normalized_options(optional_string(request, "options"));
    EqData* data = nullptr;
    const int code = tradedates_(start_date.c_str(), end_date.c_str(), options.c_str(), &data);
    if (code != 0) throw upstream_error(code, "Choice tradedates failed", true);
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE", "Choice tradedates returned no data", 502);
    }
    try {
      Json rows = Json::array();
      for (auto date : eq_strings(data->dates)) {
        date = normalize_date(std::move(date));
        rows.push_back({{"date", std::move(date)}});
      }
      release_data_(data);
      return {{"function", "TRADEDATES"}, {"fields", Json::array({"date"})},
              {"rows", std::move(rows)}};
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  Json query_ctr(const Json& request) {
    const auto report_name = required_string(request, "reportName", 256);
    const auto indicators = optional_string(request, "indicators");
    const auto options = normalized_options(optional_string(request, "options"));
    EqCtrData* data = nullptr;
    const int code = ctr_(report_name.c_str(), indicators.c_str(), options.c_str(), &data);
    if (code != 0) throw upstream_error(code, "Choice ctr failed", true);
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE", "Choice ctr returned no data", 502);
    }
    try {
      auto table = record_table("CTR", *data, indicators);
      release_data_(data);
      return table;
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  Json query_edb(const Json& request) {
    const auto ids = required_string(request, "edbIds");
    const auto start_date = required_string(request, "startDate", 10);
    const auto end_date = required_string(request, "endDate", 10);
    auto options = normalized_options(optional_string(request, "options"),
                                      {"STARTDATE", "ENDDATE"});
    options = "StartDate=" + start_date + ",EndDate=" + end_date + "," + options;
    EqData* data = nullptr;
    const int code = edb_(ids.c_str(), options.c_str(), &data);
    if (code != 0) throw upstream_error(code, "Choice edb failed", true);
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE", "Choice edb returned no data", 502);
    }
    try {
      auto table = sequence_table("EDB", *data, ids, "RESULT", true);
      release_data_(data);
      return table;
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  Json query_data_statistics(const Json& request) {
    const auto function_name = optional_string(request, "funcName", 64);
    const auto indicators = optional_string(request, "indicators");
    const auto start_date = optional_string(request, "startDate", 10);
    const auto end_date = optional_string(request, "endDate", 10);
    if (start_date.empty() != end_date.empty()) {
      throw RpcError("INVALID_REQUEST",
                     "startDate and endDate must be provided together", 400);
    }
    auto options = normalized_options(optional_string(request, "options"),
                                      {"STARTDATE", "ENDDATE"});
    if (!start_date.empty()) {
      options = "StartDate=" + start_date + ",EndDate=" + end_date + "," + options;
    }
    EqCtrData* data = nullptr;
    const int code = data_statistics_(function_name.c_str(), indicators.c_str(),
                                      options.c_str(), &data);
    if (code != 0) {
      throw upstream_error(code, "Choice datastatistics failed", true);
    }
    if (data == nullptr) {
      throw RpcError("CHOICE_INVALID_RESPONSE",
                     "Choice datastatistics returned no data", 502);
    }
    try {
      auto table = record_table("DATASTATISTICS", *data, indicators);
      release_data_(data);
      return table;
    } catch (...) {
      release_data_(data);
      throw;
    }
  }

  void* library_ = nullptr;
  std::string library_path_;
  StartFunction start_ = nullptr;
  ManualActivateFunction manual_activate_ = nullptr;
  StopFunction stop_ = nullptr;
  SetServerListDirectoryFunction set_server_list_directory_ = nullptr;
  GetErrorStringFunction error_string_ = nullptr;
  ReleaseDataFunction release_data_ = nullptr;
  CsdFunction csd_ = nullptr;
  CssFunction css_ = nullptr;
  TradedatesFunction tradedates_ = nullptr;
  CtrFunction ctr_ = nullptr;
  EdbFunction edb_ = nullptr;
  DataStatisticsFunction data_statistics_ = nullptr;
  bool logged_in_ = false;
  std::mutex mutex_;
};

}  // namespace

std::string normalize_choice_date(std::string value) {
  return normalize_date(std::move(value));
}

std::unique_ptr<ChoiceBackend> make_dynamic_choice_backend() {
  return std::make_unique<DynamicChoiceBackend>();
}

}  // namespace choice_rpc
