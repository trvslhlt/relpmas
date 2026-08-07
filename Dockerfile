# Build context is the *parent* directory (see docker-compose.yml and the
# Makefile's build-image target: `docker build -f Dockerfile ..`), not this
# directory -- relpmas depends on the sibling bruit-kit package via a
# `file:../bruit-kit` dependency, and the `build`/`runtime` stages below
# need bruit-kit's real compiled files, not just a resolvable path. The
# `dev` stage doesn't strictly need the wider context (docker-compose bind-
# mounts the live sibling in at runtime instead), but shares it since a
# Dockerfile's stages all see the same context.

# --- dev: what docker-compose runs locally, with source bind-mounted in.
# npm install succeeds even though ../bruit-kit isn't part of this stage's
# own COPY set: file: dependencies just create a symlink at the given
# relative path, resolved lazily -- it's fine for that symlink to be
# dangling at build time as long as docker-compose's bind mount (see
# docker-compose.yml) makes it real before anything actually imports from
# it. ---
FROM node:20-alpine AS dev
WORKDIR /workspace/relpmas
COPY relpmas/package*.json ./
RUN npm install
COPY relpmas/ .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# --- bruit-kit-dist: compiles the sibling package from source, since the
# runtime bind mount `dev` relies on doesn't exist during an isolated
# `docker build`. ---
FROM node:20-alpine AS bruit-kit-dist
WORKDIR /workspace/bruit-kit
COPY bruit-kit/package*.json ./
RUN npm install
COPY bruit-kit/ .
RUN npm run build

# --- build: compiles the static production bundle, now that bruit-kit's
# dist/ genuinely exists at the path relpmas's file: dependency resolves
# to. ---
FROM node:20-alpine AS build
COPY --from=bruit-kit-dist /workspace/bruit-kit /workspace/bruit-kit
WORKDIR /workspace/relpmas
COPY relpmas/package*.json ./
RUN npm install
COPY relpmas/ .
RUN npm run build

# --- runtime: the actual deployable image, just static files + nginx ---
FROM nginx:alpine AS runtime
COPY --from=build /workspace/relpmas/dist /usr/share/nginx/html
EXPOSE 80
