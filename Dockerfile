FROM mhart/alpine-node:6.3.0

MAINTAINER ContainerShip Developers <developers@containership.io>

ENV CSHIP_LOG_PATH=/var/log/containership

WORKDIR /src
COPY package.json /src/package.json
COPY app.js /src/app.js
RUN npm install

CMD node /src/app.js
