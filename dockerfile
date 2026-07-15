# LineOps backend — Lambda container image via AWS Lambda Web Adapter (LWA).
# LWA lets your existing Express server run on Lambda almost unchanged: it
# receives API Gateway / Function URL events and forwards them as normal HTTP
# requests to your app on localhost. No handler rewrite needed.
#
# IMPORTANT: build for linux/amd64 (x86_64) unless you configure the Lambda for
# arm64. On Windows/Intel this is the default. On an ARM Mac add:
#   docker build --platform linux/amd64 ...

FROM public.ecr.aws/docker/library/node:20-slim

# --- Lambda Web Adapter (the bridge) --------------------------------------
# Check https://github.com/awslabs/aws-lambda-web-adapter for the latest tag.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app

# --- Dependencies ---------------------------------------------------------
# bcrypt is a native module; include build tools so it compiles on slim, then
# remove them to keep the image small.
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# --- App source -----------------------------------------------------------
COPY . .

# --- RDS/Aurora CA bundle for TLS (used by the SSL patch in server1.js) ----
RUN curl -sSL -o /app/global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# --- Lambda Web Adapter configuration -------------------------------------
# Your app listens on PORT; tell LWA the same port and a readiness endpoint.
ENV PORT=5000
ENV AWS_LWA_PORT=5000
ENV AWS_LWA_READINESS_CHECK_PATH=/api/health
ENV NODE_ENV=production

# Start the Express server normally. LWA (in /opt/extensions) handles the
# Lambda Runtime API and proxies invocations to it.
CMD ["node", "server1.js"]