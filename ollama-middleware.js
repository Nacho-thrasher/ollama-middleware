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

// Route that handles structured output with schema
app.post('/api/structured-chat', async (req, res) => {
  try {
    const { model, messages, response_format, transforms } = req.body;
    
    if (!model || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request format' });
    }
    
    // Call Ollama API
    const response = await axios.post(`${OLLAMA_API}/api/chat`, {
      model,
      messages,
      stream: false // Important: disable streaming for structured output
    });
    
    if (!response.data || !response.data.message || !response.data.message.content) {
      return res.status(500).json({ error: 'Invalid response from Ollama' });
    }
    
    let result = response.data.message.content;
    
    // If JSON schema is requested, try to extract JSON from the response
    if (response_format && response_format.type === 'json_schema') {
      try {
        // Find JSON in the text response - Ollama might wrap it with markdown or other text
        const jsonMatch = result.match(/```json\n([\s\S]*?)\n```/) || 
                          result.match(/\{[\s\S]*\}/);
                          
        if (jsonMatch) {
          const jsonStr = jsonMatch[1] || jsonMatch[0];
          const parsedJson = JSON.parse(jsonStr);
          
          // Validate against schema if provided
          if (response_format.schema && !validateAgainstSchema(parsedJson, response_format.schema)) {
            return res.status(400).json({ 
              error: 'Response does not match schema',
              originalResponse: result
            });
          }
          
          result = parsedJson;
        } else {
          return res.status(400).json({ 
            error: 'Could not extract valid JSON from response',
            originalResponse: result
          });
        }
      } catch (jsonError) {
        return res.status(400).json({ 
          error: 'Failed to parse JSON from response',
          originalResponse: result,
          parseError: jsonError.message
        });
      }
    }
    
    // Return the formatted result
    return res.json({
      model,
      result,
      timestamp: new Date().toISOString(),
      service: req.body.service || 'ollama-middleware'
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
