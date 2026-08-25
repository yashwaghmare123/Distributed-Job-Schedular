FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./

ENV DATABASE_URL="postgresql://scheduler:scheduler_password@localhost:5432/job_scheduler?schema=public"

RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

EXPOSE 5000

CMD ["npm", "start"]