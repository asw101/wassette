#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSPECTOR_PACKAGE="${INSPECTOR_PACKAGE:-@modelcontextprotocol/inspector@2.2.0}"
INSPECTOR_BIN="${INSPECTOR_BIN:-$REPO_ROOT/tests/mcp-inspector/node_modules/.bin/mcp-inspector}"
INSPECTOR_CONFIG="${INSPECTOR_CONFIG:-$REPO_ROOT/.config/mcp-inspector.json}"
WASSETTE_BIN="${WASSETTE_BIN:-$REPO_ROOT/bin/wassette}"
READY_URL="${READY_URL:-http://127.0.0.1:9001/ready}"
FIXTURE_URL="${FIXTURE_URL:-http://127.0.0.1:9002/fixture.txt}"

FETCH_COMPONENT="${FETCH_COMPONENT:-$REPO_ROOT/examples/fetch-rs/target/wasm32-wasip2/release/fetch_rs.wasm}"
FILESYSTEM_COMPONENT="${FILESYSTEM_COMPONENT:-$REPO_ROOT/examples/filesystem-rs/target/wasm32-wasip2/release/filesystem.wasm}"
TIME_COMPONENT="${TIME_COMPONENT:-$REPO_ROOT/examples/time-server-js/time.wasm}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wassette-inspector.XXXXXX")"
WASSETTE_PID=""
HTTP_PID=""

cleanup() {
    local exit_code=$?

    if [[ -n "$HTTP_PID" ]] && kill -0 "$HTTP_PID" 2>/dev/null; then
        kill "$HTTP_PID"
        wait "$HTTP_PID" 2>/dev/null || true
    fi
    if [[ -n "$WASSETTE_PID" ]] && kill -0 "$WASSETTE_PID" 2>/dev/null; then
        kill "$WASSETTE_PID"
        wait "$WASSETTE_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: $1 is required" >&2
        exit 1
    fi
}

for command in curl jq node npx python3; do
    require_command "$command"
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`error: MCP Inspector v2 requires Node >=22.19.0; found ${process.versions.node}`);
  process.exit(1);
}
'

for path in "$INSPECTOR_CONFIG" "$WASSETTE_BIN" "$FETCH_COMPONENT" "$FILESYSTEM_COMPONENT" "$TIME_COMPONENT"; do
    if [[ ! -e "$path" ]]; then
        echo "error: required test artifact does not exist: $path" >&2
        exit 1
    fi
done

mkdir -p "$TMP_DIR/components" "$TMP_DIR/http" "$TMP_DIR/fs"
printf 'served by the Wassette Inspector fixture\n' > "$TMP_DIR/http/fixture.txt"
printf 'read through a real filesystem component\n' > "$TMP_DIR/fs/component.txt"

python3 -m http.server 9002 --bind 127.0.0.1 --directory "$TMP_DIR/http" \
    >"$TMP_DIR/http.log" 2>&1 &
HTTP_PID=$!

RUST_LOG=warn "$WASSETTE_BIN" serve \
    --streamable-http \
    --bind-address 127.0.0.1:9001 \
    --component-dir "$TMP_DIR/components" \
    >"$TMP_DIR/wassette.log" 2>&1 &
WASSETTE_PID=$!

for _ in $(seq 1 100); do
    if curl --fail --silent "$READY_URL" >/dev/null; then
        break
    fi
    if ! kill -0 "$WASSETTE_PID" 2>/dev/null; then
        echo "error: Wassette exited before becoming ready" >&2
        cat "$TMP_DIR/wassette.log" >&2
        exit 1
    fi
    sleep 0.1
done

if ! curl --fail --silent "$READY_URL" >/dev/null; then
    echo "error: Wassette did not become ready" >&2
    cat "$TMP_DIR/wassette.log" >&2
    exit 1
fi

inspector() {
    local server=$1
    shift
    if [[ -x "$INSPECTOR_BIN" ]]; then
        "$INSPECTOR_BIN" --cli \
            --config "$INSPECTOR_CONFIG" \
            --server "$server" \
            "$@" \
            --format json
    else
        npx --yes "$INSPECTOR_PACKAGE" --cli \
            --config "$INSPECTOR_CONFIG" \
            --server "$server" \
            "$@" \
            --format json
    fi
}

call_tool() {
    local server=$1
    local name=$2
    local arguments=$3
    inspector "$server" \
        --method tools/call \
        --tool-name "$name" \
        --tool-args-json "$arguments"
}

assert_tool_call_succeeded() {
    jq -e '
        .result
        | (.isError // false) == false
        and (.content | type == "array" and length > 0)
    ' >/dev/null
}

echo "Checking MCP 2 discovery and legacy initialization"
modern_info="$(inspector wassette-modern --method initialize)"
legacy_info="$(inspector wassette-legacy --method initialize)"
jq -e '.result.protocolVersion == "2026-07-28"' <<<"$modern_info" >/dev/null
jq -e '
    .result.protocolVersion != "2026-07-28"
    and (.result.serverInfo.name | type == "string" and length > 0)
' \
    <<<"$legacy_info" >/dev/null

echo "Checking one-shot MCP surfaces in both protocol eras"
for server in wassette-modern wassette-legacy; do
    inspector "$server" --method tools/list \
        | jq -e '.result.tools | any(.name == "load-component")' >/dev/null
    inspector "$server" --method resources/list \
        | jq -e '.result.resources | type == "array"' >/dev/null
    inspector "$server" --method resources/templates/list \
        | jq -e '.result.resourceTemplates | type == "array"' >/dev/null
    inspector "$server" --method prompts/list \
        | jq -e '.result.prompts | type == "array"' >/dev/null
    call_tool "$server" list-components '{}' | assert_tool_call_succeeded
done

echo "Loading representative Rust and JavaScript components through MCP 2"
fetch_load="$(call_tool wassette-modern load-component "$(jq -cn --arg path "$FETCH_COMPONENT" '{path: $path}')")"
filesystem_load="$(call_tool wassette-modern load-component "$(jq -cn --arg path "$FILESYSTEM_COMPONENT" '{path: $path}')")"
time_load="$(call_tool wassette-modern load-component "$(jq -cn --arg path "$TIME_COMPONENT" '{path: $path}')")"

fetch_id="$(jq -r '.result.content[0].text | fromjson | .id' <<<"$fetch_load")"
filesystem_id="$(jq -r '.result.content[0].text | fromjson | .id' <<<"$filesystem_load")"
time_id="$(jq -r '.result.content[0].text | fromjson | .id' <<<"$time_load")"

[[ "$fetch_id" == "fetch_rs" ]]
[[ "$filesystem_id" == "filesystem" ]]
[[ -n "$time_id" && "$time_id" != "null" ]]

for server in wassette-modern wassette-legacy; do
    tools="$(inspector "$server" --method tools/list)"
    jq -e '
        .result.tools
        | (any(.name == "fetch"))
          and (any(.name == "read-file"))
          and (any(.name == "get-current-time"))
    ' <<<"$tools" >/dev/null
done

echo "Calling the JavaScript component through both protocol eras"
call_tool wassette-modern get-current-time '{}' | assert_tool_call_succeeded
call_tool wassette-legacy get-current-time '{}' | assert_tool_call_succeeded

echo "Granting and exercising filesystem access through MCP 2"
storage_args="$(jq -cn \
    --arg component_id "$filesystem_id" \
    --arg uri "fs://$TMP_DIR/fs" \
    '{component_id: $component_id, details: {uri: $uri, access: ["read"]}}')"
call_tool wassette-modern grant-storage-permission "$storage_args" | assert_tool_call_succeeded
read_args="$(jq -cn --arg path "$TMP_DIR/fs/component.txt" '{path: $path}')"
read_result="$(call_tool wassette-modern read-file "$read_args")"
assert_tool_call_succeeded <<<"$read_result"
jq -e '.result.content[0].text | contains("read through a real filesystem component")' \
    <<<"$read_result" >/dev/null

echo "Granting and exercising network access through legacy MCP"
network_args="$(jq -cn \
    --arg component_id "$fetch_id" \
    '{component_id: $component_id, details: {host: "127.0.0.1"}}')"
call_tool wassette-legacy grant-network-permission "$network_args" | assert_tool_call_succeeded
fetch_args="$(jq -cn --arg url "$FIXTURE_URL" '{url: $url}')"
fetch_result="$(call_tool wassette-legacy fetch "$fetch_args")"
assert_tool_call_succeeded <<<"$fetch_result"
jq -e '.result.content[0].text | contains("served by the Wassette Inspector fixture")' \
    <<<"$fetch_result" >/dev/null

echo "Confirming shared server state from both client eras"
for server in wassette-modern wassette-legacy; do
    components="$(call_tool "$server" list-components '{}')"
    jq -e '
        .result.content[0].text
        | fromjson
        | .components
        | (any(.id == "fetch_rs"))
          and (any(.id == "filesystem"))
          and (length == 3)
    ' <<<"$components" >/dev/null
done

echo "MCP Inspector dual-era component tests passed"
