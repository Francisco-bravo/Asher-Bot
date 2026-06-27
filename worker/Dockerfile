FROM node:22-slim

# ffmpeg (transcodifica a Opus) + yt-dlp estático (trae su propio Python; usa el
# node de la imagen como runtime JS para el nsig de YouTube).
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates curl && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
        -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs .

ENV PORT=8080 \
    YTDLP=/usr/local/bin/yt-dlp \
    FFMPEG=ffmpeg \
    COOKIES_FILE=/cookies.txt \
    AUDIO_FORMAT=opus

EXPOSE 8080
CMD ["node", "server.mjs"]
