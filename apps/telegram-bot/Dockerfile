FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including typescript for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Note: Not pruning dependencies to ensure all runtime deps are available
# All dependencies are needed for the bot to run

# Expose port (optional, for health checks)
EXPOSE 3002

# Run the bot
CMD ["node", "dist/index.js"]
