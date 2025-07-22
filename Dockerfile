# Use Node.js LTS
FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the TypeScript project using npm scripts
RUN npm run build || \
    (npm install -g typescript esbuild && \
     npx esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js --format=cjs)

# Install production dependencies only
RUN npm ci --production

# Install SSE wrapper dependencies
RUN npm install express cors

# Copy SSE wrapper
COPY sse-wrapper.js .

# Make the built file executable
RUN chmod +x dist/index.js

# Expose port
EXPOSE 8000

# Set environment variables
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Run SSE wrapper
CMD ["node", "sse-wrapper.js"]
