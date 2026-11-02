"""
Complete 6-Scenario End-to-End Test Suite for Smart Rain Alert System
Simulates sensor transitions, dashboard remote control, and hardware responses
"""
import os
import sys
import unittest

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from database import engine, SessionLocal, Base
import models
from main import (
    receive_sensor_data,
    silence_alarm,
    get_alarm_status,
    get_alarm_command,
    get_sensor_stats,
    SensorDataCreate
)


class TestSixAlarmScenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(bind=engine)

    def setUp(self):
        self.db = SessionLocal()

    def tearDown(self):
        self.db.close()

    def test_scenario_01_dry_condition(self):
        """
        Test 1: Dry condition
        - Green LED ON, Red LED OFF, Buzzer OFF
        - Telemetry records NO RAIN
        - Alarm status is ACTIVE/READY
        """
        payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=1, # DO Pin HIGH = Dry
            rain_status="NO RAIN",
            buzzer_status="OFF",
            red_led_status="OFF",
            green_led_status="ON"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertEqual(res["message"], "Sensor data saved successfully")
        self.assertFalse(res["silence_alarm"])

        # Check alarm status
        alarm = get_alarm_status(db=self.db)
        self.assertEqual(alarm["alarm_status"], "ACTIVE")
        self.assertFalse(alarm["is_silenced"])

        # Check command for ESP8266
        cmd = get_alarm_command(db=self.db)
        self.assertFalse(cmd["silence_alarm"])
        self.assertEqual(cmd["command"], "NORMAL")

    def test_scenario_02_rain_detected(self):
        """
        Test 2: Rain detected
        - Red LED ON, Green LED OFF, Buzzer ON
        - Dashboard receives RAIN DETECTED and ALARM ACTIVE
        """
        payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=0, # DO Pin LOW = Rain
            rain_status="RAIN",
            buzzer_status="ON",
            red_led_status="ON",
            green_led_status="OFF"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertEqual(res["message"], "Sensor data saved successfully")
        self.assertFalse(res["silence_alarm"])

        stats = get_sensor_stats(db=self.db)
        self.assertEqual(stats["latest_reading"]["rain_status"], "RAIN")
        self.assertEqual(stats["latest_reading"]["buzzer_status"], "ON")
        self.assertEqual(stats["latest_reading"]["red_led_status"], "ON")
        self.assertEqual(stats["latest_reading"]["green_led_status"], "OFF")
        self.assertEqual(stats["alarm_status"], "ACTIVE")
        self.assertFalse(stats["is_silenced"])

    def test_scenario_03_silence_alarm(self):
        """
        Test 3: Silence alarm
        - Dashboard clicks SILENCE ALARM
        - Silence state saved in database
        - ESP8266 retrieves silence command
        - Physical buzzer turns OFF while Red LED remains ON, Green LED OFF
        """
        # User clicks SILENCE ALARM on React dashboard
        silence_res = silence_alarm(db=self.db)
        self.assertEqual(silence_res["status"], "success")
        self.assertEqual(silence_res["alarm_status"], "SILENCED")
        self.assertTrue(silence_res["is_silenced"])

        # ESP8266 checks command endpoint
        cmd = get_alarm_command(db=self.db)
        self.assertTrue(cmd["silence_alarm"])
        self.assertEqual(cmd["alarm_status"], "SILENCED")
        self.assertEqual(cmd["command"], "SILENCE")

        # ESP8266 applies silence to buzzer and posts telemetry
        payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=0,
            rain_status="RAIN",
            buzzer_status="OFF", # Silenced buzzer
            red_led_status="ON",  # Red LED stays ON
            green_led_status="OFF" # Green LED stays OFF
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertTrue(res["silence_alarm"])
        self.assertEqual(res["alarm_status"], "SILENCED")

    def test_scenario_04_rain_continues(self):
        """
        Test 4: Rain continues
        - Buzzer remains OFF
        - Red LED remains ON
        - Sensor readings continue reaching the backend
        - Alarm remains SILENCED
        """
        for _ in range(3):
            payload = SensorDataCreate(
                device_id="NodeMCU",
                sensor_value=0,
                rain_status="RAIN",
                buzzer_status="OFF", # Buzzer stays OFF
                red_led_status="ON",
                green_led_status="OFF"
            )
            res = receive_sensor_data(data=payload, db=self.db)
            self.assertTrue(res["silence_alarm"])
            self.assertEqual(res["alarm_status"], "SILENCED")

        cmd = get_alarm_command(db=self.db)
        self.assertTrue(cmd["silence_alarm"])

    def test_scenario_05_rain_stops(self):
        """
        Test 5: Rain stops
        - Sensor detects dry conditions
        - Buzzer OFF, Red LED OFF, Green LED ON
        - Silence state resets automatically (re-arms)
        """
        payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=1, # Dry
            rain_status="NO RAIN",
            buzzer_status="OFF",
            red_led_status="OFF",
            green_led_status="ON"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        # Automatic re-arm triggered
        self.assertFalse(res["silence_alarm"])
        self.assertEqual(res["alarm_status"], "ACTIVE")

        status = get_alarm_status(db=self.db)
        self.assertEqual(status["alarm_status"], "ACTIVE")
        self.assertFalse(status["is_silenced"])

        cmd = get_alarm_command(db=self.db)
        self.assertFalse(cmd["silence_alarm"])
        self.assertEqual(cmd["command"], "NORMAL")

    def test_scenario_06_rain_starts_again(self):
        """
        Test 6: Rain starts again
        - Buzzer automatically turns ON (re-armed!)
        - Red LED turns ON, Green LED OFF
        - Alarm becomes ACTIVE again
        """
        payload = SensorDataCreate(
            device_id="NodeMCU",
            sensor_value=0, # Rain starts again
            rain_status="RAIN",
            buzzer_status="ON", # Buzzer sounds again
            red_led_status="ON",
            green_led_status="OFF"
        )
        res = receive_sensor_data(data=payload, db=self.db)
        self.assertFalse(res["silence_alarm"]) # Not silenced
        self.assertEqual(res["alarm_status"], "ACTIVE")

        cmd = get_alarm_command(db=self.db)
        self.assertFalse(cmd["silence_alarm"])
        self.assertEqual(cmd["alarm_status"], "ACTIVE")


if __name__ == "__main__":
    unittest.main()

