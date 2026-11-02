# Dockerfile for Smart Rain Alert System - FastAPI Backend
FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable immediate logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first for optimal build layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source files
COPY main.py database.py models.py ./

# Create data directory for SQLite persistence when run locally in Docker
RUN mkdir -p /app/data

# Default port for FastAPI (Render overrides with dynamic $PORT)
EXPOSE 8000

# Run uvicorn server binding to 0.0.0.0 and dynamic $PORT for Render compatibility
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
