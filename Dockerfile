FROM node:20-alpine
ARG AGENT_DIR
COPY ${AGENT_DIR} /opt/nodejs
