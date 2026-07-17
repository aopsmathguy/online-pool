# Koyeb / container build for the online-pool server.
# The server serves the static client AND the WebSocket game on one HTTP port.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching (only `ws` at runtime).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (vendored libs under lib/, client under src/, server under server/).
COPY . .

# Koyeb injects PORT; default here matches Koyeb's default service port.
ENV PORT=8000
EXPOSE 8000

CMD ["npm", "start"]
