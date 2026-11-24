FROM node:24-alpine
WORKDIR /app
COPY index.html style.css ./
COPY js/ js/
COPY server/ server/
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/server.js"]
