import os
import sys
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Boolean

# Ensure directory is on path for flexible execution
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

try:
    from database import Base
except ImportError:
    from .database import Base


def get_current_time():
    """Returns current UTC timestamp"""
    return datetime.now(timezone.utc)


class RainReading(Base):
    __tablename__ = "rain_readings"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(String, default="NodeMCU")
    sensor_value = Column(Integer, nullable=False)
    rain_status = Column(String, nullable=False)
    buzzer_status = Column(String, default="OFF")
    red_led_status = Column(String, default="OFF")
    green_led_status = Column(String, default="OFF")
    timestamp = Column(DateTime, default=get_current_time)


class AlarmState(Base):
    __tablename__ = "alarm_state"

    id = Column(Integer, primary_key=True, index=True)
    is_silenced = Column(Boolean, default=False, nullable=False)
    status = Column(String, default="ACTIVE", nullable=False)  # "ACTIVE" or "SILENCED"
    updated_at = Column(DateTime, default=get_current_time)
