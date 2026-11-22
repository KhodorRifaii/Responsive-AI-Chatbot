# Docker image for a Hugging Face Docker Space (also runs anywhere Docker runs).
# The Gemini key is NOT in the image: add GOOGLE_API_KEY as a Space secret.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=7860 \
    # CPU binaries ship with onnxruntime-node; skip the optional GPU (CUDA) download.
    ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /app

# Hugging Face runs containers as uid 1000, the same uid as the image's "node" user.
# Owning /app lets the app write its embedding model cache to /app/.cache/models.
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# Download the embedding model at build time so the first upload is fast.
RUN node --input-type=module -e "const { LocalEmbeddings } = await import('./src/services/embeddings.js'); await new LocalEmbeddings({ model: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2' }).embedQuery('warm up'); console.log('Embedding model cached');"

EXPOSE 7860

CMD ["node", "src/server.js"]
