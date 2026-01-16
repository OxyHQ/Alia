FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port (optional, for health checks)
EXPOSE 3002

# Run the bot
CMD ["node", "dist/index.js"]
