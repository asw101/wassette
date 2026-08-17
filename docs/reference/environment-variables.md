# Environment Variables

Pass environment variables to Wassette components using shell exports or config files. Components need explicit permission to access variables.

## Server Configuration

Wassette supports the following environment variables for server configuration (following the [twelve-factor app](https://12factor.net/) methodology):

### PORT
Sets the port number for Streamable HTTP when `bind_address` is not specified via CLI or config file.

```bash
PORT=8080 wassette serve --streamable-http
```

Default: `9001`

**Precedence:** CLI (`--bind-address`) > Config file (`bind_address`) > PORT/BIND_HOST > Default (127.0.0.1:9001)

### BIND_HOST
Sets the host address to bind to for HTTP-based transports when `bind_address` is not specified via CLI or config file.

```bash
BIND_HOST=0.0.0.0 wassette serve --streamable-http
```

Default: `127.0.0.1` (localhost only)

**Note:** In Docker containers, use `BIND_HOST=0.0.0.0` to allow external connections.

**Precedence:** CLI (`--bind-address`) > Config file (`bind_address`) > PORT/BIND_HOST > Default (127.0.0.1:9001)

### WASSETTE_LEGACY_SESSIONS
Controls whether the pre-`2026-07-28` MCP session lifecycle is still served. Equivalent to `--legacy-sessions`.

```bash
WASSETTE_LEGACY_SESSIONS=false wassette serve --streamable-http
```

Default: `true`

Clients negotiating protocol revision `2026-07-28` or later are served statelessly either way. Setting this to `false` only removes the session lifecycle that older clients need, so `initialize` stops minting a session id and `GET`/`DELETE` on `/mcp` return `405`.

**Precedence:** CLI (`--legacy-sessions`) > `WASSETTE_LEGACY_SESSIONS` > Config file (`legacy_sessions`) > Default (`true`)

### WASSETTE_JSON_RESPONSE
Returns `application/json` instead of a request-scoped `text/event-stream` for a simple request that produces a single reply. Equivalent to `--json-response`.

```bash
WASSETTE_JSON_RESPONSE=true wassette serve --streamable-http
```

Default: `false`

Wassette falls back to an event stream when a request produces more than one message, so nothing is lost.

**Precedence:** CLI (`--json-response`) > `WASSETTE_JSON_RESPONSE` > Config file (`json_response`) > Default (`false`)

### WASSETTE_CONFIG_FILE
Path to custom configuration file.

```bash
WASSETTE_CONFIG_FILE=/path/to/config.toml wassette serve
```

Default: `$XDG_CONFIG_HOME/wassette/config.toml`

## Component Environment Variables

### Quick Start

```bash
export OPENWEATHER_API_KEY="your_key"
wassette run
wassette permission grant environment-variable weather-tool OPENWEATHER_API_KEY
```

## Recommended Method

Use `wassette secret set` to securely pass environment variables to components:

```bash
wassette secret set weather-tool API_KEY "your_secret_key"
```

This stores the secret securely and makes it available to the component when granted permission.

## Grant Access

```bash
wassette permission grant environment-variable weather-tool API_KEY
```

Or in policy file:

```yaml
version: "1.0"
permissions:
  environment:
    allow:
      - key: "API_KEY"
```

## See Also

- [Permissions](./permissions.md) - Permission system details
- [Configuration Files](./configuration-files.md) - Complete config.toml reference  
