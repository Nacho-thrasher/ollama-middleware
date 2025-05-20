FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY ollama-middleware.js ./

EXPOSE 3000

# Environment variables
ENV PORT=3000
ENV OLLAMA_API=http://ollama-railway.railway.internal:11434

CMD ["node", "ollama-middleware.js"]
