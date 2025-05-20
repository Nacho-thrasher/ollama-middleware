const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Configuración de Ollama API
const OLLAMA_API = process.env.OLLAMA_API || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gemma:2b';

// Manejo de errores para axios
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response) {
      console.error('Error de API de Ollama:', error.response.status, error.response.data);
    } else if (error.request) {
      console.error('No se recibió respuesta de Ollama:', error.request);
    } else {
      console.error('Error al configurar la solicitud:', error.message);
    }
    return Promise.reject(error);
  }
);

/**
 * Valida datos contra un esquema JSON
 * @param {Object} data - Datos a validar
 * @param {Object} schema - Esquema JSON para validación
 * @returns {boolean} - Resultado de validación
 */
function validateAgainstSchema(data, schema) {
  // Validación básica - usar una biblioteca como Ajv en producción
  try {
    const required = schema.required || [];
    for (const prop of required) {
      if (!(prop in data)) {
        console.warn(`Falta propiedad requerida: ${prop}`);
        return false;
      }
    }
    
    // Validación de tipo básica para propiedades existentes
    for (const [prop, value] of Object.entries(data)) {
      const propSchema = schema.properties?.[prop];
      if (propSchema && propSchema.type) {
        if ((propSchema.type === 'number' && typeof value !== 'number') ||
            (propSchema.type === 'string' && typeof value !== 'string') ||
            (propSchema.type === 'boolean' && typeof value !== 'boolean') ||
            (propSchema.type === 'array' && !Array.isArray(value)) ||
            (propSchema.type === 'object' && (typeof value !== 'object' || Array.isArray(value) || value === null))) {
          console.warn(`Tipo inválido para ${prop}: esperaba ${propSchema.type}, recibió ${typeof value}`);
          return false;
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error en validación de esquema:', error);
    return false;
  }
}

/**
 * Crea un prompt de sistema para forzar salida en JSON
 * @param {Object} schema - Esquema JSON para la respuesta
 * @returns {string} - Prompt de sistema formateado
 */
function createJsonFormatSystemPrompt(schema) {
  const schemaStr = JSON.stringify(schema, null, 2);
  return `Debes responder con JSON válido que siga estrictamente este esquema:
${schemaStr}

No incluyas explicaciones, formato markdown ni texto fuera de la estructura JSON.
Tu respuesta completa debe poder analizarse como JSON. No envuelvas el JSON en bloques de código ni markdown.
Responde únicamente con un objeto JSON válido que coincida con el esquema anterior.`;
}

/**
 * Extrae JSON del texto con múltiples estrategias de fallback
 * @param {string} text - Texto de respuesta del modelo
 * @param {Object} schema - Esquema JSON para validación y generación
 * @returns {Object} - Objeto JSON extraído o generado
 */
async function extractJsonFromText(text, schema) {
  // Intenta parseo directo primero
  try {
    const directJson = JSON.parse(text);
    console.log('JSON extraído directamente');
    return directJson;
  } catch (e) {
    // No es JSON válido, continúa con intentos de extracción
    console.log('Fallo al parsear JSON directamente, intentando extracciones alternativas');
  }

  // Busca JSON en bloques de código
  const codeBlockMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const codeBlockJson = JSON.parse(codeBlockMatch[1]);
      console.log('JSON extraído de bloque de código');
      return codeBlockJson;
    } catch (e) {
      console.log('Fallo al parsear JSON desde bloque de código');
    }
  }

  // Busca cualquier estructura similar a JSON
  const jsonLikeMatch = text.match(/\{[\s\S]*\}/);
  if (jsonLikeMatch) {
    try {
      const jsonLikeContent = JSON.parse(jsonLikeMatch[0]);
      console.log('JSON extraído de estructura similar a JSON');
      return jsonLikeContent;
    } catch (e) {
      console.log('Fallo al parsear estructura similar a JSON');
    }
  }

  // Si tenemos un esquema, intenta generar la estructura JSON
  if (schema) {
    console.log('Intentando generar JSON basado en el texto y esquema');
    return await generateJsonFromText(text, schema);
  }

  // No se encontró JSON válido
  throw new Error('No se pudo extraer JSON válido de la respuesta');
}

/**
 * Genera JSON a partir de texto basado en un esquema
 * @param {string} text - Texto para convertir a JSON
 * @param {Object} schema - Esquema JSON para guiar la conversión
 * @returns {Object} - Objeto JSON generado
 */
async function generateJsonFromText(text, schema) {
  try {
    // Crea un prompt basado en esquema
    const generateJsonPrompt = [
      {
        role: 'system',
        content: `Eres un asistente de transformación JSON. Convierte el siguiente texto en un objeto JSON válido que siga el esquema especificado. Solo genera el objeto JSON sin explicaciones ni markdown.`
      },
      {
        role: 'user',
        content: `Convierte este texto a JSON siguiendo este esquema: ${JSON.stringify(schema)}\n\nTexto a convertir: ${text}`
      }
    ];

    // Llama al modelo nuevamente para generar JSON adecuado
    const model = process.env.TRANSFORM_MODEL || DEFAULT_MODEL; // Usa un modelo rápido para transformación
    console.log(`Usando modelo ${model} para transformación JSON`);
    
    const jsonResponse = await axios.post(`${OLLAMA_API}/api/chat`, {
      model,
      messages: generateJsonPrompt,
      stream: false
    });

    const jsonContent = jsonResponse.data.message.content;
    
    // Intenta extraer JSON de la respuesta
    const jsonMatch = jsonContent.match(/```(?:json)?\n?([\s\S]*?)\n?```/) || 
                     jsonContent.match(/\{[\s\S]*\}/);
                    
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      return JSON.parse(jsonStr);
    }
    
    // Último recurso - intento de análisis directo
    return JSON.parse(jsonContent);
  } catch (e) {
    console.error('Error en generación de JSON:', e.message);
    // Si todo falla, crea un objeto válido mínimo del esquema
    return createMinimalValidObject(schema);
  }
}

/**
 * Crea un objeto mínimo válido basado en los requisitos del esquema
 * @param {Object} schema - Esquema JSON
 * @returns {Object} - Objeto mínimo válido
 */
function createMinimalValidObject(schema) {
  const result = {};
  
  if (!schema || !schema.properties) {
    return { error: "No se pudo generar JSON válido de la respuesta" };
  }
  
  // Rellena propiedades requeridas con valores válidos mínimos
  const required = schema.required || [];
  for (const propName of required) {
    const propSchema = schema.properties[propName];
    if (!propSchema) continue;
    
    switch (propSchema.type) {
      case 'string':
        result[propName] = propSchema.description || `${propName} autogenerado`;
        break;
      case 'number':
      case 'integer':
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

// Ruta principal que maneja salida estructurada con esquema
app.post('/api/structured-chat', async (req, res) => {
  const startTime = Date.now();
  try {
    const { model, messages, response_format, transforms, service } = req.body;
    
    if (!model) {
      return res.status(400).json({ error: 'Se requiere especificar un modelo' });
    }
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Se requieren mensajes válidos' });
    }
    
    // Modifica los mensajes para fomentar la salida JSON cuando se usa esquema
    let modifiedMessages = [...messages];
    
    // Si se solicita un esquema JSON, agrega instrucciones al prompt del sistema
    if (response_format && response_format.type === 'json_schema' && response_format.schema) {
      // Verifica si hay un mensaje de sistema
      const hasSystemMessage = messages.some(msg => msg.role === 'system');
      
      if (hasSystemMessage) {
        // Agrega requisitos de formato JSON al mensaje de sistema existente
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
        // Agrega un nuevo mensaje de sistema con requisitos de formato JSON
        modifiedMessages.unshift({
          role: 'system',
          content: createJsonFormatSystemPrompt(response_format.schema)
        });
      }
    }
    
    console.log(`Realizando solicitud a Ollama API para modelo ${model}`);
    
    // Llama a la API de Ollama
    const ollamaRequest = {
      model,
      messages: modifiedMessages,
      stream: false // Importante: deshabilita streaming para salida estructurada
    };
    
    // Agrega opciones opcionales si están presentes
    if (req.body.options) {
      ollamaRequest.options = req.body.options;
    }
    
    const response = await axios.post(`${OLLAMA_API}/api/chat`, ollamaRequest);
    
    if (!response.data || !response.data.message || !response.data.message.content) {
      return res.status(500).json({ error: 'Respuesta inválida de Ollama' });
    }
    
    let result = response.data.message.content;
    
    // Si se solicita esquema JSON, extrae o genera JSON de la respuesta
    if (response_format && response_format.type === 'json_schema') {
      try {
        // Usa nuestra función de extracción mejorada
        const parsedJson = await extractJsonFromText(result, response_format.schema);
        
        // Valida contra esquema
        if (response_format.schema && !validateAgainstSchema(parsedJson, response_format.schema)) {
          console.log("Falló la validación de esquema, intentando arreglar...");
          // Intenta generar una respuesta válida como fallback
          result = await generateJsonFromText(result, response_format.schema);
        } else {
          result = parsedJson;
        }
      } catch (jsonError) {
        console.error('Error de procesamiento JSON:', jsonError.message);
        // Último recurso - crear objeto válido mínimo
        if (response_format.schema) {
          result = createMinimalValidObject(response_format.schema);
          return res.json({
            model,
            result,
            timestamp: new Date().toISOString(),
            service: service || 'ollama-middleware',
            warning: 'No se pudo analizar la respuesta del modelo como JSON. Devolviendo fallback generado.',
            latency: Date.now() - startTime
          });
        } else {
          return res.status(400).json({ 
            error: 'Falló al analizar JSON de la respuesta',
            originalResponse: result,
            parseError: jsonError.message,
            latency: Date.now() - startTime
          });
        }
      }
    }
    
    // Aplica transformaciones personalizadas si están especificadas
    if (transforms && Array.isArray(transforms)) {
      for (const transform of transforms) {
        if (transform.type === 'filter' && transform.fields) {
          // Implementa filtrado básico de campos
          const filteredResult = {};
          for (const field of transform.fields) {
            if (result && field in result) {
              filteredResult[field] = result[field];
            }
          }
          result = filteredResult;
        }
        // Podrías implementar más transformaciones aquí
      }
    }
    
    // Devuelve el resultado formateado
    return res.json({
      model,
      result,
      timestamp: new Date().toISOString(),
      service: service || 'ollama-middleware',
      latency: Date.now() - startTime
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ 
      error: 'Error del servidor', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      latency: Date.now() - startTime
    });
  }
});

// Ruta para chat simple (no estructurado)
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  try {
    const { model = DEFAULT_MODEL, messages, stream = false, options } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Se requieren mensajes válidos' });
    }
    
    // Si solicita streaming, maneja de forma diferente
    if (stream) {
      // Configura cabeceras para streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Realiza solicitud a Ollama con streaming
      const response = await axios.post(`${OLLAMA_API}/api/chat`, {
        model,
        messages,
        stream: true,
        ...options && { options }
      }, { responseType: 'stream' });
      
      // Pipe directo de la respuesta de Ollama al cliente
      response.data.pipe(res);
      return;
    }
    
    // Para solicitudes no streaming
    const response = await axios.post(`${OLLAMA_API}/api/chat`, {
      model,
      messages,
      stream: false,
      ...options && { options }
    });
    
    return res.json({
      ...response.data,
      timestamp: new Date().toISOString(),
      latency: Date.now() - startTime
    });
    
  } catch (error) {
    console.error('Error en chat:', error.message);
    return res.status(500).json({ 
      error: 'Error del servidor', 
      message: error.message,
      latency: Date.now() - startTime
    });
  }
});

// Ruta para listar modelos disponibles
app.get('/api/models', async (req, res) => {
  try {
    const response = await axios.get(`${OLLAMA_API}/api/tags`);
    return res.json(response.data);
  } catch (error) {
    console.error('Error al listar modelos:', error.message);
    return res.status(500).json({ 
      error: 'Error al listar modelos', 
      message: error.message 
    });
  }
});

// Verificación de salud básica
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Inicia servidor
app.listen(port, () => {
  console.log(`Servicio middleware de Ollama escuchando en puerto ${port}`);
  console.log(`API de Ollama configurada en: ${OLLAMA_API}`);
  console.log(`Modelo predeterminado: ${DEFAULT_MODEL}`);
});