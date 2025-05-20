const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Ollama API endpoint
const OLLAMA_API = process.env.OLLAMA_API || 'http://localhost:11434';

// Helper to validate against provided JSON schema
function validateAgainstSchema(data, schema) {
  // Simple validation - would use a proper JSON Schema validator in production
  const required = schema.required || [];
  for (const prop of required) {
    if (!(prop in data)) {
      return false;
    }
  }
  return true;
}

// Enhanced system prompt to force JSON output
function createJsonFormatSystemPrompt(schema) {
  const schemaStr = JSON.stringify(schema, null, 2);
  return `You must respond with valid JSON that strictly follows this schema:
${schemaStr}

Do not include any explanations, markdown formatting, or text outside of the JSON structure.
Your entire response must be parseable as JSON. Do not wrap the JSON in code blocks or markdown.
Respond with only a single valid JSON object that matches the schema above.`;
}

// Function to attempt JSON extraction with fallbacks
async function extractJsonFromText(text, schema) {
  // Try direct parsing first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Not valid JSON, continue with extraction attempts
  }

  // Look for JSON in code blocks
  const codeBlockMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (e) {
      // Not valid JSON in code block, continue
    }
  }

  // Look for any JSON-like structure
  const jsonLikeMatch = text.match(/\{[\s\S]*\}/);
  if (jsonLikeMatch) {
    try {
      return JSON.parse(jsonLikeMatch[0]);
    } catch (e) {
      // Not valid JSON, continue
    }
  }

  // If we have a schema, try to generate the JSON structure
  if (schema) {
    return await generateJsonFromText(text, schema);
  }

  // No valid JSON found
  throw new Error('Could not extract valid JSON from response');
}

// Function to generate JSON from text based on schema
async function generateJsonFromText(text, schema) {
  try {
    // Create a schema-based prompt
    const generateJsonPrompt = [
      {
        role: 'system',
        content: `You are a JSON transformation assistant. Convert the following text into a valid JSON object that follows the specified schema. Only output the JSON object without any explanation or markdown.`
      },
      {
        role: 'user',
        content: `Convert this text to JSON following this schema: ${JSON.stringify(schema)}\n\nText to convert: ${text}`
      }
    ];

    // Call the model again to generate proper JSON
    const model = 'gemma:2b'; // Use a fast model for transformation
    const jsonResponse = await axios.post(`${OLLAMA_API}/api/chat`, {
      model,
      messages: generateJsonPrompt,
      stream: false
    });

    const jsonContent = jsonResponse.data.message.content;
    
    // Try to extract JSON from the response
    const jsonMatch = jsonContent.match(/```(?:json)?\n?([\s\S]*?)\n?```/) || 
                    jsonContent.match(/\{[\s\S]*\}/);
                    
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      return JSON.parse(jsonStr);
    }
    
    // Last resort - try direct parsing
    return JSON.parse(jsonContent);
  } catch (e) {
    // If all else fails, create a minimal valid object from the schema
    return createMinimalValidObject(schema);
  }
}

// Create a minimal valid object based on schema requirements
function createMinimalValidObject(schema) {
  const result = {};
  
  if (!schema || !schema.properties) {
    return { error: "Could not generate valid JSON from response" };
  }
  
  // Fill in required properties with minimal valid values
  const required = schema.required || [];
  for (const propName of required) {
    const propSchema = schema.properties[propName];
    if (!propSchema) continue;
    
    switch (propSchema.type) {
      case 'string':
        result[propName] = propSchema.description || `Auto-generated ${propName}`;
        break;
      case 'number':
        result[propName] = 0;
        break;
      case 'boolean':
        result[propName] = false;
        break;
      case 'array':
        result[propName] = [];
        break;
      case 'object':
        result[propName] = {};
        break;
      default:
        result[propName] = null;
    }
  }
  
  return result;
}

// Route that handles structured output with schema
app.post('/api/structured-chat', async (req, res) => {
  try {
    const { model, messages, response_format, transforms, service } = req.body;
    
    if (!model || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request format' });
    }
    
    // Modify the messages to encourage JSON output when using schema
    let modifiedMessages = [...messages];
    
    // If a JSON schema is requested, add instructions to the system prompt
    if (response_format && response_format.type === 'json_schema' && response_format.schema) {
      // Check if there's a system message
      const hasSystemMessage = messages.some(msg => msg.role === 'system');
      
      if (hasSystemMessage) {
        // Append JSON format requirements to existing system message
        modifiedMessages = messages.map(msg => {
          if (msg.role === 'system') {
            return {
              ...msg,
              content: `${msg.content}\n\n${createJsonFormatSystemPrompt(response_format.schema)}`
            };
          }
          return msg;
        });
      } else {
        // Add a new system message with JSON format requirements
        modifiedMessages.unshift({
          role: 'system',
          content: createJsonFormatSystemPrompt(response_format.schema)
        });
      }
    }
    
    // Call Ollama API
    const response = await axios.post(`${OLLAMA_API}/api/chat`, {
      model,
      messages: modifiedMessages,
      stream: false // Important: disable streaming for structured output
    });
    
    if (!response.data || !response.data.message || !response.data.message.content) {
      return res.status(500).json({ error: 'Invalid response from Ollama' });
    }
    
    let result = response.data.message.content;
    
    // If JSON schema is requested, extract or generate JSON from the response
    if (response_format && response_format.type === 'json_schema') {
      try {
        // Use our enhanced extraction function
        const parsedJson = await extractJsonFromText(result, response_format.schema);
        
        // Validate against schema
        if (response_format.schema && !validateAgainstSchema(parsedJson, response_format.schema)) {
          console.log("Schema validation failed, attempting to fix...");
          // Try to generate a valid response as fallback
          result = await generateJsonFromText(result, response_format.schema);
        } else {
          result = parsedJson;
        }
      } catch (jsonError) {
        console.error('JSON processing error:', jsonError.message);
        // Last resort fallback - create minimal valid object
        if (response_format.schema) {
          result = createMinimalValidObject(response_format.schema);
          return res.json({
            model,
            result,
            timestamp: new Date().toISOString(),
            service: service || 'ollama-middleware',
            warning: 'Could not parse model response as JSON. Returning generated fallback.'
          });
        } else {
          return res.status(400).json({ 
            error: 'Failed to parse JSON from response',
            originalResponse: result,
            parseError: jsonError.message
          });
        }
      }
    }
    
    // Return the formatted result
    return res.json({
      model,
      result,
      timestamp: new Date().toISOString(),
      service: service || 'ollama-middleware'
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ 
      error: 'Server error', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Basic health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(port, () => {
  console.log(`Ollama middleware service listening on port ${port}`);
});
