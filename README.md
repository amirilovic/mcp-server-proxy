# MCP Server Proxy

A proxy server that connects to multiple MCP servers and provides a unified interface for tool access.

## Features

- Connect to multiple MCP servers simultaneously
- Support for multiple configuration profiles
- Tool name prefixing with server names
- Run in either stdio or SSE mode
- Profile-based configuration management

## Configuration

Create configuration files for each profile in the format `config.<profile>.json`. For example:

```json
// config.developer.json
{
    "mcpServers": {
        "kubernetes": {
            "command": "kubectl",
            "args": ["proxy", "--port=8001"]
        },
        "docker": {
            "command": "docker",
            "args": ["info"]
        }
    }
}

// config.personal.json
{
    "mcpServers": {
        "local": {
            "command": "python",
            "args": ["local_server.py"]
        }
    }
}
```

## Installation

```bash
npm install
```

## Usage

### Command Line Options

The server can be started with various command-line options:

```bash
# Start with default settings
node dist/server.js

# Start with a specific profile
node dist/server.js --profile developer
# or
node dist/server.js -p developer

# Start in SSE mode
node dist/server.js --mode sse
# or
node dist/server.js -m sse

# Start in SSE mode with custom port and host
node dist/server.js --mode sse --port 8080 --host 0.0.0.0

# Combine options
node dist/server.js --profile developer --mode sse --port 8080
```

Available options:
- `-p, --profile <name>`: Specify which profile to use (defaults to "default")
- `-m, --mode <mode>`: Choose between "stdio" or "sse" mode (defaults to "stdio")
- `--port <number>`: Set the port for SSE mode (defaults to 3000)
- `--host <host>`: Set the host for SSE mode (defaults to "localhost")

Get help:
```bash
node dist/server.js --help
```

### Tool Naming Convention

Tools are prefixed with their server name. For example:
- A tool named `get_pods` from the `kubernetes` server becomes `kubernetes_get_pods`
- A tool named `list_containers` from the `docker` server becomes `docker_list_containers`

### SSE Mode Endpoints

When running in SSE mode, the server exposes the following endpoints:

- `GET /sse`: Establishes an SSE connection
- `POST /messages`: Handles tool requests (requires `sessionId` query parameter)

Example SSE client usage:
```javascript
const eventSource = new EventSource('http://localhost:3000/sse');
eventSource.onmessage = (event) => {
    console.log('Received:', event.data);
};
```

## Example Usage

1. Start the server with the developer profile:
```bash
node dist/server.js --profile developer
```

2. List available tools:
```bash
# Tools will be listed with their server-prefixed names
# Example output:
# - kubernetes_get_pods
# - docker_list_containers
```

3. Call a tool:
```bash
# Call the kubernetes_get_pods tool
# The proxy will automatically route the call to the correct server
```

## Error Handling

The server provides detailed error messages including:
- Profile loading errors
- Server connection failures
- Tool not found errors
- Server disconnection errors

All errors include the current profile name for better context.

## Development

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Run tests:
```bash
npm test
```

## License

MIT 