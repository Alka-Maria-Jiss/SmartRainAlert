import os
import sys
from datetime import datetime, timezone
from typing import List, Optional

# Ensure backend directory is in sys.path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict

from database import engine, Base, SessionLocal
import models

# Create database tables if they do not exist
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Smart Rain Alert System",
    description="Backend API for Smart Rain Alert System IoT Project with Remote Alarm Control",
    version="1.1.0"
)

# Configure CORS using actual deployed frontend URL and local dev origins (No wildcard '*')
frontend_url = os.getenv("FRONTEND_URL", "https://smart-rain-alert-dashboard.onrender.com")

allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:3000",
    frontend_url.rstrip("/"),
]
# Clean and deduplicate origins
allowed_origins = [origin for origin in dict.fromkeys(allowed_origins) if origin]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"^https:\/\/.*\.onrender\.com$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# Dependency to get database session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Helper to get or initialize singleton alarm state
def get_or_create_alarm_state(db: Session) -> models.AlarmState:
    state = db.query(models.AlarmState).filter_by(id=1).first()
    if not state:
        state = models.AlarmState(
            id=1,
            is_silenced=False,
            status="ACTIVE",
            updated_at=datetime.now(timezone.utc)
        )
        db.add(state)
        db.commit()
        db.refresh(state)
    return state


# Pydantic schemas
class SensorDataCreate(BaseModel):
    device_id: str = "NodeMCU"
    sensor_value: int
    rain_status: str
    buzzer_status: str = "OFF"
    red_led_status: str = "OFF"
    green_led_status: str = "OFF"


class SensorReadingResponse(BaseModel):
    id: int
    device_id: str
    sensor_value: int
    rain_status: str
    buzzer_status: str
    red_led_status: str
    green_led_status: str
    timestamp: datetime

    model_config = ConfigDict(from_attributes=True)


class AlarmStatusResponse(BaseModel):
    status: str
    alarm_status: str
    is_silenced: bool
    message: Optional[str] = None
    updated_at: Optional[str] = None


class AlarmCommandResponse(BaseModel):
    silence_alarm: bool
    alarm_status: str
    command: str


# Home route
@app.get("/")
def home():
    return {
        "message": "Smart Rain Alert System Backend is Running!",
        "version": "1.1.0",
        "docs": "/docs"
    }


# Health check endpoint for Render monitoring
@app.get("/health")
@app.get("/api/health")
def health_check(db: Session = Depends(get_db)):
    try:
        total_records = db.query(models.RainReading).count()
        latest = db.query(models.RainReading).order_by(
            models.RainReading.timestamp.desc(),
            models.RainReading.id.desc()
        ).first()
        alarm = get_or_create_alarm_state(db)

        return {
            "status": "healthy",
            "service": "Smart Rain Alert System Backend",
            "database": "Connected",
            "total_records": total_records,
            "latest_reading_time": latest.timestamp.isoformat() if latest and latest.timestamp else None,
            "alarm_status": alarm.status,
            "alarm_silenced": alarm.is_silenced,
            "server_time": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database health check failed: {str(e)}"
        )


# Test database connection (preserved from existing implementation)
@app.get("/test")
def test(db: Session = Depends(get_db)):
    try:
        count = db.query(models.RainReading).count()
        return {
            "status": "success",
            "database": "Connected",
            "total_readings": count
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database connection error: {str(e)}"
        )


# Receive sensor readings from ESP8266 or simulated node
@app.post("/api/sensor-data", status_code=status.HTTP_200_OK)
def receive_sensor_data(data: SensorDataCreate, db: Session = Depends(get_db)):
    try:
        new_reading = models.RainReading(
            device_id=data.device_id,
            sensor_value=data.sensor_value,
            rain_status=data.rain_status,
            buzzer_status=data.buzzer_status,
            red_led_status=data.red_led_status,
            green_led_status=data.green_led_status
        )

        db.add(new_reading)

        # Automatic Alarm Re-arming:
        # When sensor detects dry conditions, automatically reset silence state so future rain alarms trigger
        alarm_state = get_or_create_alarm_state(db)
        if data.rain_status == "NO RAIN" and alarm_state.is_silenced:
            alarm_state.is_silenced = False
            alarm_state.status = "ACTIVE"
            alarm_state.updated_at = datetime.now(timezone.utc)

        db.commit()
        db.refresh(new_reading)

        return {
            "message": "Sensor data saved successfully",
            "id": new_reading.id,
            "silence_alarm": alarm_state.is_silenced,
            "alarm_status": alarm_state.status
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save sensor data: {str(e)}"
        )


# Retrieve sensor readings (ordered newest first)
@app.get("/api/sensor-data", response_model=List[SensorReadingResponse])
def get_sensor_data(
    limit: Optional[int] = Query(None, description="Optional maximum number of records to return"),
    db: Session = Depends(get_db)
):
    try:
        query = db.query(models.RainReading).order_by(
            models.RainReading.timestamp.desc(),
            models.RainReading.id.desc()
        )
        if limit is not None and limit > 0:
            query = query.limit(limit)

        readings = query.all()
        return readings
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve sensor data: {str(e)}"
        )


# Summary statistics endpoint for the dashboard
@app.get("/api/sensor-data/stats")
def get_sensor_stats(db: Session = Depends(get_db)):
    try:
        total = db.query(models.RainReading).count()
        rain_count = db.query(models.RainReading).filter(
            models.RainReading.rain_status == "RAIN"
        ).count()
        dry_count = total - rain_count

        latest = db.query(models.RainReading).order_by(
            models.RainReading.timestamp.desc(),
            models.RainReading.id.desc()
        ).first()

        alarm_state = get_or_create_alarm_state(db)

        latest_data = None
        if latest:
            latest_data = {
                "id": latest.id,
                "device_id": latest.device_id,
                "sensor_value": latest.sensor_value,
                "rain_status": latest.rain_status,
                "buzzer_status": latest.buzzer_status,
                "red_led_status": latest.red_led_status,
                "green_led_status": latest.green_led_status,
                "timestamp": latest.timestamp.isoformat() if latest.timestamp else None
            }

        return {
            "total_readings": total,
            "rain_readings": rain_count,
            "dry_readings": dry_count,
            "latest_reading": latest_data,
            "alarm_status": alarm_state.status,
            "is_silenced": alarm_state.is_silenced,
            "alarm_updated_at": alarm_state.updated_at.isoformat() if alarm_state.updated_at else None
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate stats: {str(e)}"
        )


# ==========================================
# REMOTE ALARM CONTROL ENDPOINTS
# ==========================================

# Dashboard sends silence command
@app.post("/api/alarm/silence", response_model=AlarmStatusResponse)
def silence_alarm(db: Session = Depends(get_db)):
    try:
        alarm = get_or_create_alarm_state(db)
        alarm.is_silenced = True
        alarm.status = "SILENCED"
        alarm.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(alarm)

        return {
            "status": "success",
            "message": "Alarm silenced successfully",
            "alarm_status": alarm.status,
            "is_silenced": alarm.is_silenced,
            "updated_at": alarm.updated_at.isoformat() if alarm.updated_at else None
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to silence alarm: {str(e)}"
        )


# Dashboard retrieves current alarm status
@app.get("/api/alarm/status", response_model=AlarmStatusResponse)
def get_alarm_status(db: Session = Depends(get_db)):
    try:
        alarm = get_or_create_alarm_state(db)
        return {
            "status": "success",
            "alarm_status": alarm.status,
            "is_silenced": alarm.is_silenced,
            "message": "Alarm is silenced" if alarm.is_silenced else "Alarm is active",
            "updated_at": alarm.updated_at.isoformat() if alarm.updated_at else None
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch alarm status: {str(e)}"
        )


# ESP8266 retrieves latest alarm command
@app.get("/api/alarm/command", response_model=AlarmCommandResponse)
def get_alarm_command(db: Session = Depends(get_db)):
    try:
        alarm = get_or_create_alarm_state(db)
        return {
            "silence_alarm": alarm.is_silenced,
            "alarm_status": alarm.status,
            "command": "SILENCE" if alarm.is_silenced else "NORMAL"
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch alarm command: {str(e)}"
        )


# Optional: Reset/Re-arm alarm manually from API
@app.post("/api/alarm/reset", response_model=AlarmStatusResponse)
def reset_alarm(db: Session = Depends(get_db)):
    try:
        alarm = get_or_create_alarm_state(db)
        alarm.is_silenced = False
        alarm.status = "ACTIVE"
        alarm.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(alarm)

        return {
            "status": "success",
            "message": "Alarm re-armed successfully",
            "alarm_status": alarm.status,
            "is_silenced": alarm.is_silenced,
            "updated_at": alarm.updated_at.isoformat() if alarm.updated_at else None
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to reset alarm: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
