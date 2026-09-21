# ---------------------------------------------------------------------------
# Venice — image de production.
#
# Playwright + Chromium sont indispensables : c'est le navigateur headless qui
# résout le challenge Cloudflare posé devant chat.dphn.ai. Render (runtime
# Docker) est la cible recommandée, car `playwright install --with-deps`
# a besoin d'être root — ce qui est le cas dans une image Docker, pas dans un
# build Node natif.
#
# Alternative : remplacer la première ligne par
#     FROM mcr.microsoft.com/playwright:v1.63.0-jammy
# (le navigateur est alors préinstallé ; alignez la version sur celle de
#  package.json).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Dépendances système de Chromium + polices (Playwright les installe,
# et les ajoute à l'image sans laisser de cache).
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY . .

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
