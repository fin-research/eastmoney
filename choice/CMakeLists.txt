cmake_minimum_required(VERSION 3.20)
project(eastmoney_choice_rpc LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ENABLE_COVERAGE "Instrument offline CTest targets for gcov" OFF)
if(ENABLE_COVERAGE)
  add_compile_options(--coverage -O0 -g)
  add_link_options(--coverage)
endif()

find_package(nlohmann_json 3.11 REQUIRED)

add_library(choice_rpc_core
  src/choice_backend.cpp
  src/rpc_contract.cpp
)
target_include_directories(choice_rpc_core PUBLIC include)
target_link_libraries(choice_rpc_core PUBLIC nlohmann_json::nlohmann_json ${CMAKE_DL_LIBS})
target_compile_options(choice_rpc_core PRIVATE -Wall -Wextra -Wpedantic -Werror)

add_executable(choice-rpc src/main.cpp)
target_link_libraries(choice-rpc PRIVATE choice_rpc_core pthread)
target_compile_options(choice-rpc PRIVATE -Wall -Wextra -Wpedantic -Werror)

enable_testing()
add_executable(choice-rpc-tests tests/test_rpc.cpp)
target_link_libraries(choice-rpc-tests PRIVATE choice_rpc_core)
target_compile_options(choice-rpc-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME choice-rpc-tests COMMAND choice-rpc-tests)

add_executable(choice-rpc-authorization-tests tests/test_authorization.cpp)
target_link_libraries(choice-rpc-authorization-tests PRIVATE choice_rpc_core pthread)
target_compile_options(choice-rpc-authorization-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME choice-rpc-authorization-tests COMMAND choice-rpc-authorization-tests)
