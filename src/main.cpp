#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include "secrets.h"
#include "certs.h"

// Pin connections
const int rainPin = D5;
const int buzzerPin = D1;
const int redLED = D6;
const int greenLED = D7;

// Rain sensor logic
const int RAIN_DETECTED = LOW;

// Active-LOW buzzer logic
const int BUZZER_ON = LOW;
const int BUZZER_OFF = HIGH;

// ==============================================================================
// BACKEND TARGET CONFIGURATION
// Set USE_RENDER_CLOUD to 1 to connect to Render Cloud backend over HTTPS
// Set USE_RENDER_CLOUD to 0 for local laptop development over HTTP
// ==============================================================================
#define USE_RENDER_CLOUD 0

#if USE_RENDER_CLOUD
  // Render Cloud HTTPS endpoints (Update subdomain if different on Render)
  const char* serverUrl = "https://smart-rain-backend.onrender.com/api/sensor-data";
  const char* commandUrl = "https://smart-rain-backend.onrender.com/api/alarm/command";
#else
  // Local development endpoints (Local Laptop Wi-Fi IP)
  const char* serverUrl = "http://10.97.246.66:8000/api/sensor-data";
  const char* commandUrl = "http://10.97.246.66:8000/api/alarm/command";
#endif

// State variable for remote silence control
bool alarmSilenced = false;

// Trust anchor list for BearSSL cryptographic TLS certificate validation (ISRG Root X1)
X509List trustedCert(ISRG_ROOT_X1_CA);

void setup() {
  Serial.begin(115200);

  pinMode(rainPin, INPUT);

  // Initialize buzzer in OFF state (Active-LOW: HIGH = OFF)
  digitalWrite(buzzerPin, BUZZER_OFF);
  pinMode(buzzerPin, OUTPUT);

  pinMode(redLED, OUTPUT);
  pinMode(greenLED, OUTPUT);

  // Initial output states
  digitalWrite(buzzerPin, BUZZER_OFF);
  digitalWrite(redLED, LOW);
  digitalWrite(greenLED, HIGH);

  Serial.println();
  Serial.println("Smart Rain Alert System Started");

  // Connect to Wi-Fi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("Wi-Fi Connected!");
  Serial.print("NodeMCU IP Address: ");
  Serial.println(WiFi.localIP());

#if USE_RENDER_CLOUD
  // Synchronize system time via NTP for proper TLS certificate expiration validation
  Serial.println("Synchronizing NTP time for TLS verification...");
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  time_t now = time(nullptr);
  int retry = 0;
  while (now < 8 * 3600 * 2 && retry < 20) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
    retry++;
  }
  Serial.println();
  if (now >= 8 * 3600 * 2) {
    Serial.println("NTP Time synchronized. TLS Certificate verification active.");
  } else {
    Serial.println("NTP sync timed out; continuing...");
  }
#endif
}

void loop() {
  // Read rain sensor
  int rainValue = digitalRead(rainPin);

  // Automatic Alarm Re-arming:
  // If sensor detects dry conditions, reset silence state so future rain alarms trigger immediately
  if (rainValue != RAIN_DETECTED) {
    if (alarmSilenced) {
      Serial.println("Condition: DRY -> Resetting alarm silence state (Re-armed).");
    }
    alarmSilenced = false;
  }

  // Check backend for remote alarm commands if Wi-Fi is connected
  if (WiFi.status() == WL_CONNECTED) {
#if USE_RENDER_CLOUD
    WiFiClientSecure client;
    // Proper TLS verification: Validates Render's certificate against ISRG Root X1 CA
    client.setTrustAnchor(&trustedCert);
#else
    WiFiClient client;
#endif

    HTTPClient httpCmd;

    // Set a short timeout (2000ms) to prevent blocking
    httpCmd.setTimeout(2000);
    httpCmd.begin(client, commandUrl);

    int cmdCode = httpCmd.GET();
    if (cmdCode == 200) {
      String cmdPayload = httpCmd.getString();
      // Check if backend instructed to silence alarm
      if (cmdPayload.indexOf("\"silence_alarm\":true") >= 0 || cmdPayload.indexOf("\"command\":\"SILENCE\"") >= 0) {
        if (!alarmSilenced && rainValue == RAIN_DETECTED) {
          Serial.println(">> Remote Silence Command Received: Silencing buzzer!");
        }
        if (rainValue == RAIN_DETECTED) {
          alarmSilenced = true;
        }
      } else if (cmdPayload.indexOf("\"silence_alarm\":false") >= 0 || cmdPayload.indexOf("\"command\":\"NORMAL\"") >= 0) {
        if (rainValue != RAIN_DETECTED) {
          alarmSilenced = false;
        }
      }
    }
    httpCmd.end();
  }

  // Determine LED and Buzzer states based on sensor and silence status
  String rainStatus;
  String redStatus;
  String greenStatus;
  String buzzerStatus;

  if (rainValue == RAIN_DETECTED) {
    // Rain detected
    rainStatus = "RAIN";
    redStatus = "ON";
    greenStatus = "OFF";

    // LEDs strictly controlled by actual sensor readings
    digitalWrite(redLED, HIGH);
    digitalWrite(greenLED, LOW);

    // Buzzer controlled by rain + remote silence command
    if (alarmSilenced) {
      buzzerStatus = "OFF";
      digitalWrite(buzzerPin, BUZZER_OFF); // Active-LOW: HIGH = OFF
      Serial.println("RAIN DETECTED - ALARM SILENCED (BUZZER OFF) - RED LED ON");
    } else {
      buzzerStatus = "ON";
      digitalWrite(buzzerPin, BUZZER_ON);  // Active-LOW: LOW = ON
      Serial.println("RAIN DETECTED - BUZZER ON - RED LED ON");
    }

  } else {
    // No rain detected (Dry)
    rainStatus = "NO RAIN";
    redStatus = "OFF";
    greenStatus = "ON";
    buzzerStatus = "OFF";
    alarmSilenced = false; // Re-arm alarm

    // Hardware outputs for dry condition
    digitalWrite(buzzerPin, BUZZER_OFF); // Active-LOW: HIGH = OFF
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);

    Serial.println("NO RAIN - BUZZER OFF - GREEN LED ON");
  }

  Serial.print("Sensor value: ");
  Serial.println(rainValue);

  // Send sensor data to FastAPI backend
  if (WiFi.status() == WL_CONNECTED) {
#if USE_RENDER_CLOUD
    WiFiClientSecure client;
    client.setTrustAnchor(&trustedCert);
#else
    WiFiClient client;
#endif

    HTTPClient http;

    http.setTimeout(3000);
    http.begin(client, serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonData = "{";
    jsonData += "\"device_id\":\"NodeMCU\",";
    jsonData += "\"sensor_value\":" + String(rainValue) + ",";
    jsonData += "\"rain_status\":\"" + rainStatus + "\",";
    jsonData += "\"buzzer_status\":\"" + buzzerStatus + "\",";
    jsonData += "\"red_led_status\":\"" + redStatus + "\",";
    jsonData += "\"green_led_status\":\"" + greenStatus + "\"";
    jsonData += "}";

    Serial.println("Sending data to backend...");

    int httpCode = http.POST(jsonData);

    if (httpCode > 0) {
      Serial.print("Backend response code: ");
      Serial.println(httpCode);
      String responseBody = http.getString();
      Serial.println(responseBody);

      // Dual update: If POST response contains silence command and rain is active, apply immediately
      if (rainValue == RAIN_DETECTED && responseBody.indexOf("\"silence_alarm\":true") >= 0) {
        alarmSilenced = true;
        digitalWrite(buzzerPin, BUZZER_OFF);
      }
    } else {
      Serial.print("HTTP request failed: ");
      Serial.println(http.errorToString(httpCode));
    }

    http.end();

  } else {
    Serial.println("Wi-Fi disconnected!");
    WiFi.reconnect();
  }

  // Wait 2 seconds before next reading
  delay(2000);
}
