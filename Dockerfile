FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

# Install ALL deps (including devDeps) so vite/TypeScript are available at build time
RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

# Strip dev deps from the final image after build
RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
