# The keeper as one container. Build from the repository root, so the kit comes in:
#   docker build -f services/keeper/Dockerfile -t boomerang-keeper .
# No key is built in: KEEPER_PRIVATE_KEY and DEMO_RECIPIENT are set
# on the host as secrets. The event file and the desk's notes live in /data, which must be storage
# that outlives the container: without it a restart forgets which addresses the desk already paid.
FROM node:26.13.1-slim

ENV NODE_ENV=production
WORKDIR /app

# Only the package files first, so the install is cached. npm ci needs every workspace's
# package.json to match the lock; only the keeper's and the kit's dependencies are installed.
COPY package.json package-lock.json ./
COPY packages/kit/package.json packages/kit/
COPY services/keeper/package.json services/keeper/
COPY contracts/package.json contracts/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts -w @boomerang/keeper -w @boomerang/kit && npm cache clean --force

COPY packages/kit packages/kit
COPY services/keeper/src services/keeper/src

# Inside a container the process must listen on every interface for the host's ingress to reach it.
# The ingress is then the only way in; it does not limit request rates (docs/ARCHITECTURE.md).
ENV HOST=0.0.0.0 PORT=8787 KEEPER_DATA=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787

USER node
WORKDIR /app/services/keeper
CMD ["node", "src/main.ts"]
