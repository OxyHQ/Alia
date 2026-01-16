FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (use install instead of ci since no lockfile)
RUN npm install

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
