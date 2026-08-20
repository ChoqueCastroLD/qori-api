# qori-api — Bun + Elysia + Prisma
# Debian-based Bun image: Prisma's default engine (debian-openssl) works cleanly.
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies (cached layer)
COPY package.json bun.lock* ./
RUN bun install

# Generate the Prisma client
COPY prisma ./prisma
RUN bunx prisma generate

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "bunx prisma migrate deploy && bun src/index.ts"]
