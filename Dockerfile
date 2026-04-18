FROM node:22-slim

# Directorio de trabajo
WORKDIR /app

# Copiamos archivos de dependencias
COPY package.json ./

# Instalamos (aunque ahora no tenemos dependencias externas, es buena práctica)
RUN npm install

# Copiamos el resto del código
COPY . .

# Creamos la carpeta de datos por defecto
RUN mkdir -p data

# Exponemos el puerto
EXPOSE 8080

# Comando de inicio
CMD ["npm", "start"]
