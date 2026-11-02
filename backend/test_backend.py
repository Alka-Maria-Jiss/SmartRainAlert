"""
Automated Unit and Integration Tests for Smart Rain Alert System Backend
Includes Tests for Remote Alarm Control & Automatic Re-arming
"""
import os
import sys
import unittest

# Add backend directory to sys.path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from database import engine, SessionLocal, Base
import models
from main import (
    app,
    home,
    health_check,
    test as test_route,
    get_sensor_data,
    get_sensor_stats,
    receive_sensor_data,
    silence_alarm,
    get_alarm_status,
    get_alarm_command,
    reset_alarm,
    SensorDataCreate
)


class TestSmartRainAlertBackend(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(bind=engine)

    def setUp(self):
        self.db = SessionLocal()

    def tearDown(self):
        self.db.close()

    def test_01_home_endpoint(self):
        """Test home root route"""
        res = home()
        self.assertIn("message", res)
        self.assertIn("Smart Rain Alert", res["message"])

    def test_02_health_check_endpoint(self):
        """Test health-check endpoint reports healthy status and database connection"""
        res = health_check(db=self.db)
        self.assertEqual(res["status"], "healthy")
        self.assertEqual(res["database"], "Connected")
        self.assertGreaterEqual(res["total_records"], 0)
        self.assertIn("alarm_status", res)

    def test_03_test_endpoint(self):
        """Test preserved test endpoint"""
        res = test_route(db=self.db)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["database"], "Connected")

    def test_04_save_rain_sensor_reading(self):
        """Test POST /api/sensor-data receives and records rain telemetry"""
        payload = SensorDataCreate(
            device_id="NodeMCU_TestUnit",
            sensor_value=0, # 0 = Rain detected (active-low DO)
            rain_status="RAIN",
            buzzer_status="ON",
            red_led_status="ON",
            green_led_status="OFF"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertEqual(res["message"], "Sensor data saved successfully")
        self.assertIsNotNone(res["id"])
        
        # Verify directly in SQLite
        saved = self.db.query(models.RainReading).filter_by(id=res["id"]).first()
        self.assertIsNotNone(saved)
        self.assertEqual(saved.sensor_value, 0)
        self.assertEqual(saved.rain_status, "RAIN")
        self.assertEqual(saved.buzzer_status, "ON")
        self.assertEqual(saved.red_led_status, "ON")
        self.assertEqual(saved.green_led_status, "OFF")
        self.assertEqual(saved.device_id, "NodeMCU_TestUnit")

    def test_05_save_dry_sensor_reading(self):
        """Test POST /api/sensor-data receives and records clear/dry telemetry"""
        payload = SensorDataCreate(
            device_id="NodeMCU_TestUnit",
            sensor_value=1, # 1 = Dry (active-low DO)
            rain_status="NO RAIN",
            buzzer_status="OFF",
            red_led_status="OFF",
            green_led_status="ON"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertEqual(res["message"], "Sensor data saved successfully")
        
        saved = self.db.query(models.RainReading).filter_by(id=res["id"]).first()
        self.assertIsNotNone(saved)
        self.assertEqual(saved.sensor_value, 1)
        self.assertEqual(saved.rain_status, "NO RAIN")
        self.assertEqual(saved.buzzer_status, "OFF")
        self.assertEqual(saved.red_led_status, "OFF")
        self.assertEqual(saved.green_led_status, "ON")

    def test_06_get_sensor_data_with_limit(self):
        """Test GET /api/sensor-data returns newest readings first and respects limit"""
        readings = get_sensor_data(limit=5, db=self.db)
        self.assertIsInstance(readings, list)
        self.assertLessEqual(len(readings), 5)
        if len(readings) >= 2:
            # Check descending order
            self.assertGreaterEqual(readings[0].id, readings[1].id)

    def test_07_get_sensor_stats(self):
        """Test GET /api/sensor-data/stats returns correct aggregations and alarm status"""
        stats = get_sensor_stats(db=self.db)
        self.assertIn("total_readings", stats)
        self.assertIn("rain_readings", stats)
        self.assertIn("dry_readings", stats)
        self.assertIn("alarm_status", stats)
        self.assertIn("is_silenced", stats)
        self.assertEqual(stats["total_readings"], stats["rain_readings"] + stats["dry_readings"])

    def test_08_silence_alarm_endpoint(self):
        """Test POST /api/alarm/silence updates state to SILENCED"""
        res = silence_alarm(db=self.db)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["alarm_status"], "SILENCED")
        self.assertTrue(res["is_silenced"])

    def test_09_alarm_status_and_command(self):
        """Test GET /api/alarm/status and GET /api/alarm/command return silenced state"""
        # Ensure silenced
        silence_alarm(db=self.db)
        
        status_res = get_alarm_status(db=self.db)
        self.assertEqual(status_res["alarm_status"], "SILENCED")
        self.assertTrue(status_res["is_silenced"])

        cmd_res = get_alarm_command(db=self.db)
        self.assertTrue(cmd_res["silence_alarm"])
        self.assertEqual(cmd_res["alarm_status"], "SILENCED")
        self.assertEqual(cmd_res["command"], "SILENCE")

    def test_10_continuous_rain_maintains_silence(self):
        """Test that continuous rain readings keep the alarm silenced"""
        silence_alarm(db=self.db)
        
        rain_payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=0,
            rain_status="RAIN",
            buzzer_status="OFF", # Silenced buzzer
            red_led_status="ON",
            green_led_status="OFF"
        )
        post_res = receive_sensor_data(data=rain_payload, db=self.db)
        self.assertTrue(post_res["silence_alarm"])
        self.assertEqual(post_res["alarm_status"], "SILENCED")
        
        # Check command endpoint still returns silence
        cmd_res = get_alarm_command(db=self.db)
        self.assertTrue(cmd_res["silence_alarm"])

    def test_11_automatic_rearm_when_dry(self):
        """Test that detecting dry conditions automatically resets silence state (re-arms)"""
        # First ensure alarm is silenced
        silence_alarm(db=self.db)
        self.assertTrue(get_alarm_status(db=self.db)["is_silenced"])

        # Sensor detects dry weather (NO RAIN)
        dry_payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=1,
            rain_status="NO RAIN",
            buzzer_status="OFF",
            red_led_status="OFF",
            green_led_status="ON"
        )
        post_res = receive_sensor_data(data=dry_payload, db=self.db)
        
        # Verify automatic reset/re-arm
        self.assertFalse(post_res["silence_alarm"])
        self.assertEqual(post_res["alarm_status"], "ACTIVE")

        status_res = get_alarm_status(db=self.db)
        self.assertFalse(status_res["is_silenced"])
        self.assertEqual(status_res["alarm_status"], "ACTIVE")

        cmd_res = get_alarm_command(db=self.db)
        self.assertFalse(cmd_res["silence_alarm"])
        self.assertEqual(cmd_res["command"], "NORMAL")


if __name__ == "__main__":
    unittest.main()
