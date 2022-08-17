FROM node:lts-alpine

ENV SCREENIE_CHROMIUM_ARGS=--no-sandbox
ENV SCREENIE_CHROMIUM_EXEC=/usr/lib/chromium/chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY ./src/server.js /usr/src/app/
COPY package*.json /usr/src/app/

# Installs latest Chromium package
RUN apk update && apk upgrade && \
  apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  font-noto-cjk \
  tini \
  git

RUN npm install
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 CMD curl -fs http://localhost:3000 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/usr/src/app/server.js"]

