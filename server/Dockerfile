FROM node:25-alpine AS builder

WORKDIR /app
COPY . .
RUN npm install
RUN npm run build

FROM node:25-alpine AS runtime

WORKDIR /app
RUN mkdir dist
COPY ./package*.json ./
RUN npm install
COPY --from=builder /app/dist ./dist

EXPOSE 80 443

CMD ["node", "dist/index.js"]