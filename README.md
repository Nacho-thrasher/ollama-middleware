# Ollama Middleware Service

A middleware service that sits between client applications and an Ollama instance. This service enables structured JSON output with schema validation similar to OpenRouter.

## Features

- Transform Ollama's streaming responses into structured JSON
- Support for JSON Schema validation
- Extract JSON from model outputs
- Clean response formatting
- Compatible with Railway deployment

## Environment Variables

- `PORT`: Port to run the service on (default: 3000)
- `OLLAMA_API`: URL of the Ollama API (default: http://localhost:11434)

## API Endpoints

### POST /api/structured-chat

Send chat requests with optional schema validation.

**Request Example:**

```json
{
  "model": "gemma:2b",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant"
    },
    {
      "role": "user",
      "content": "Hello, who are you?"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "schema": {
      "type": "object",
      "properties": {
        "introduction": {
          "type": "string"
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": ["introduction", "capabilities"]
    }
  }
}
```

### GET /health

Health check endpoint used by Railway for deployment monitoring.

## Deployment

This service is designed to be deployed on Railway alongside an Ollama instance.