# ── Dockerfile for SHOU demo environment ──
# Runs all 4 backend services + serves the Chrome extension for download.
# One command to test everything: docker compose up

FROM node:22-slim

WORKDIR /app

# Copy the entire shou directory (source + demo-ids.json + .env)
COPY shou/ ./

# Pre-seeded testnet object IDs (already in demo-ids.json)
# GONKA_API_KEY is passed at runtime — real DeepSeek + MiniMax scoring.
# If no key is provided, the dev heuristic is used as a fallback.
ENV NODE_ENV=development

# Install all package dependencies in one pass
RUN cd /app && \
    for d in enclave packages/*/; do \
      (cd "$d" && npm install --no-audit --no-fund 2>/dev/null || true); \
    done

# Build the extension and dashboard bundles
RUN cd /app/packages/extension && npm run build
RUN cd /app/packages/dashboard && npm run build
RUN cd /app/packages/zklogin-demo && npm run build

# Copy the startup script
COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh

EXPOSE 3000 3100 4000 4200

CMD ["/docker-start.sh"]
