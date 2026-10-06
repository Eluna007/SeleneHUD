FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY frontend ./frontend

ENV HUD_FRONTEND=/app/frontend \
    HUD_CONFIG=/config/hud.yaml \
    HUD_HOSTFS=/hostfs \
    PYTHONUNBUFFERED=1

EXPOSE 8420
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8420", "--log-level", "warning"]
