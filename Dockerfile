FROM node:20-alpine AS base

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apk add --no-cache \
	chromium \
	nss \
	freetype \
	harfbuzz \
	ca-certificates \
	ttf-freefont

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium
EXPOSE 8787

CMD ["node", "src/index.js"]
