FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

EXPOSE 5000

CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]