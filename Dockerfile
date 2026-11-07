FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Només dependències de producció (Leaflet i la tipografia ja són a vendor/)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Carpeta de dades: munta-hi un volum persistent (o defineix DATA_PATH) perquè no es perdi en redesplegar
RUN mkdir -p data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
