ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY leaderboard/src ./leaderboard/src
COPY leaderboard/data ./leaderboard/data
COPY leaderboard/migrations ./leaderboard/migrations
COPY leaderboard/ops ./leaderboard/ops
COPY src ./src
RUN mkdir /data /backups && chown node:node /data /backups
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server/main.mjs"]
