
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include "secrets.h"
#include "certs.h"

// =====================================================
// HARDWARE PINS
// =====================================================
const int rainPin = D5;
const int buzzerPin = D1;
const int redLED = D6;
const int greenLED = D7;

// =====================================================
// SENSOR AND BUZZER LOGIC
// =====================================================
const int RAIN_DETECTED = LOW;
const int BUZZER_ON = LOW;
const int BUZZER_OFF = HIGH;

// =====================================================
// BACKEND CONFIGURATION
// =====================================================
#define USE_RENDER_CLOUD 1

#if USE_RENDER_CLOUD
const char* serverUrl =
    "https://smart-rain-backend.onrender.com/api/sensor-data";

const char* commandUrl =
    "https://smart-rain-backend.onrender.com/api/alarm/command";
#else
const char* serverUrl =
    "http://10.97.246.66:8000/api/sensor-data";

const char* commandUrl =
    "http://10.97.246.66:8000/api/alarm/command";
#endif

// =====================================================
// TIMING CONFIGURATION
// =====================================================
const unsigned long SENSOR_INTERVAL = 20;
const unsigned long POST_INTERVAL = 3000;
const unsigned long COMMAND_INTERVAL = 5000;

const unsigned long NETWORK_RETRY_INTERVAL = 2000;

unsigned long lastSensorRead = 0;
unsigned long lastPost = 0;
unsigned long lastCommandCheck = 0;

unsigned long lastNetworkRetry = 0;

// =====================================================
// GLOBAL VARIABLES
// =====================================================
int rainValue = HIGH;
int previousRainValue = HIGH;

bool alarmSilenced = false;
bool urgentUpload = false;

String rainStatus;
String redStatus;
String greenStatus;
String buzzerStatus;

// =====================================================
// SSL CONFIGURATION
// =====================================================
#if USE_RENDER_CLOUD

X509List trustedCert(GLOBALSIGN_R4_CA);

void configureClient(WiFiClientSecure& client) {

    client.setBufferSizes(1024, 512);

    time_t now = time(nullptr);

    if (now >= 8 * 3600 * 2) {
        client.setTrustAnchors(&trustedCert);
    } else {
        Serial.println("WARNING: TLS certificate verification unavailable");
        client.setInsecure();
    }
}

#else

void configureClient(WiFiClient& client) {
}

#endif

// =====================================================
// UPDATE LED AND BUZZER
// =====================================================
void updateHardware() {

    if (rainValue == RAIN_DETECTED) {

        rainStatus = "RAIN";

        redStatus = "ON";
        greenStatus = "OFF";

        digitalWrite(redLED, HIGH);
        digitalWrite(greenLED, LOW);

        if (alarmSilenced) {

            buzzerStatus = "OFF";
            digitalWrite(buzzerPin, BUZZER_OFF);

        } else {

            buzzerStatus = "ON";
            digitalWrite(buzzerPin, BUZZER_ON);
        }

    } else {

        rainStatus = "NO RAIN";

        redStatus = "OFF";
        greenStatus = "ON";
        buzzerStatus = "OFF";

        digitalWrite(redLED, LOW);
        digitalWrite(greenLED, HIGH);
        digitalWrite(buzzerPin, BUZZER_OFF);

        // Re-arm alarm when dry
        alarmSilenced = false;
    }
}

// =====================================================
// READ SENSOR AND DETECT STATE CHANGES
// =====================================================
void readRainSensor() {

    int newValue = digitalRead(rainPin);

    if (newValue != rainValue) {

        rainValue = newValue;

        // Update hardware immediately
        updateHardware();

        // Request immediate cloud upload
        urgentUpload = true;

        Serial.println("--------------------------------");
        Serial.println("RAIN SENSOR STATE CHANGED!");
        Serial.print("New sensor value: ");
        Serial.println(rainValue);
        Serial.print("Rain status: ");
        Serial.println(rainStatus);
        Serial.println("--------------------------------");

    } else {

        rainValue = newValue;
    }
}

// =====================================================
// CHECK REMOTE ALARM COMMAND
// =====================================================
template <typename TClient>
void checkRemoteCommand(TClient& client) {

    HTTPClient http;

    http.setTimeout(1500);

    if (!http.begin(client, commandUrl)) {
        Serial.println("Command connection failed");
        return;
    }

    int code = http.GET();

    if (code == 200) {

        String payload = http.getString();

        if (
            payload.indexOf("\"silence_alarm\":true") >= 0 ||
            payload.indexOf("\"command\":\"SILENCE\"") >= 0
        ) {

            if (rainValue == RAIN_DETECTED) {

                alarmSilenced = true;

                updateHardware();

                Serial.println("Remote silence command received");
            }

        } else if (
            payload.indexOf("\"silence_alarm\":false") >= 0 ||
            payload.indexOf("\"command\":\"NORMAL\"") >= 0
        ) {

            if (rainValue == RAIN_DETECTED) {

                alarmSilenced = false;

                updateHardware();
            }
        }

    } else {

        Serial.print("Command HTTP response: ");
        Serial.println(code);
    }

    http.end();
}

// =====================================================
// SEND SENSOR DATA
// =====================================================
template <typename TClient>
void sendSensorData(TClient& client) {

    HTTPClient http;

    http.setTimeout(2000);

    if (!http.begin(client, serverUrl)) {

        Serial.println("Backend connection failed");
        return;
    }

    http.addHeader("Content-Type", "application/json");

    String jsonData = "{";

    jsonData += "\"device_id\":\"NodeMCU\",";
    jsonData += "\"sensor_value\":" + String(rainValue) + ",";
    jsonData += "\"rain_status\":\"" + rainStatus + "\",";
    jsonData += "\"buzzer_status\":\"" + buzzerStatus + "\",";
    jsonData += "\"red_led_status\":\"" + redStatus + "\",";
    jsonData += "\"green_led_status\":\"" + greenStatus + "\"";

    jsonData += "}";

    int code = http.POST(jsonData);

    Serial.print("Backend response code: ");
    Serial.println(code);

    if (code > 0) {

        String response = http.getString();

        Serial.println(response);

        // Read silence state from POST response if supplied.
        // This does not replace the separate command endpoint.
        if (
            response.indexOf("\"silence_alarm\":true") >= 0 &&
            rainValue == RAIN_DETECTED
        ) {

            alarmSilenced = true;
            updateHardware();

        } else if (
            response.indexOf("\"silence_alarm\":false") >= 0 &&
            rainValue == RAIN_DETECTED
        ) {

            alarmSilenced = false;
            updateHardware();
        }

    } else {

        Serial.println(http.errorToString(code));
    }

    http.end();
}

// =====================================================
// SETUP
// =====================================================
void setup() {

    Serial.begin(115200);

    pinMode(rainPin, INPUT);
    pinMode(buzzerPin, OUTPUT);
    pinMode(redLED, OUTPUT);
    pinMode(greenLED, OUTPUT);

    digitalWrite(buzzerPin, BUZZER_OFF);
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);

    Serial.println();
    Serial.println("SMART RAIN ALERT SYSTEM STARTED");

    // Connect Wi-Fi
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    Serial.print("Connecting to Wi-Fi");

    while (WiFi.status() != WL_CONNECTED) {

        delay(500);
        Serial.print(".");
    }

    Serial.println();
    Serial.println("Wi-Fi Connected!");

    Serial.println(WiFi.localIP());

#if USE_RENDER_CLOUD

    trustedCert.append(GTS_WE1_CA);
    trustedCert.append(ISRG_ROOT_X1_CA);

    Serial.println("Synchronizing NTP time...");

    configTime(0, 0, "pool.ntp.org", "time.nist.gov");

    time_t now = time(nullptr);

    int retry = 0;

    while (now < 8 * 3600 * 2 && retry < 30) {

        delay(500);

        now = time(nullptr);

        retry++;
    }

    if (now >= 8 * 3600 * 2) {

        Serial.println("NTP synchronized");

    } else {

        Serial.println("NTP synchronization timed out");
        Serial.println("TLS fallback will be used");
    }

#endif

    // Initial sensor reading
    rainValue = digitalRead(rainPin);

    updateHardware();

    previousRainValue = rainValue;

    unsigned long currentTime = millis();

    lastSensorRead = currentTime;
    lastPost = currentTime;
    lastCommandCheck = currentTime;

    Serial.println("System ready!");
}

// =====================================================
// MAIN LOOP
// =====================================================
void loop() {

    unsigned long currentTime = millis();

    // 1. READ SENSOR FIRST
    if (currentTime - lastSensorRead >= SENSOR_INTERVAL) {

        lastSensorRead = currentTime;

        readRainSensor();
    }

    // 2. HANDLE WI-FI CONNECTION
    if (WiFi.status() != WL_CONNECTED) {

        if (currentTime - lastNetworkRetry >= NETWORK_RETRY_INTERVAL) {

            lastNetworkRetry = currentTime;

            Serial.println("Wi-Fi disconnected. Reconnecting...");

            WiFi.reconnect();
        }

        yield();

        return;
    }

    // 3. URGENT UPLOAD AFTER SENSOR STATE CHANGE
    if (urgentUpload) {

        urgentUpload = false;

#if USE_RENDER_CLOUD

        WiFiClientSecure client;

#else

        WiFiClient client;

#endif

        configureClient(client);

        sendSensorData(client);

        lastPost = millis();
    }

    // 4. PERIODIC SENSOR DATA UPLOAD
    currentTime = millis();

    if (currentTime - lastPost >= POST_INTERVAL) {

        lastPost = currentTime;

#if USE_RENDER_CLOUD

        WiFiClientSecure client;

#else

        WiFiClient client;

#endif

        configureClient(client);

        sendSensorData(client);
    }

    // 5. CHECK REMOTE SILENCE COMMAND
    currentTime = millis();

    if (currentTime - lastCommandCheck >= COMMAND_INTERVAL) {

        lastCommandCheck = currentTime;

#if USE_RENDER_CLOUD

        WiFiClientSecure client;

#else

        WiFiClient client;

#endif

        configureClient(client);

        checkRemoteCommand(client);
    }

    yield();
}
