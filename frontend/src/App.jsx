import React, { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import {
  CloudRain,
  CloudSun,
  Sun,
  Droplets,
  Wifi,
  WifiOff,
  RotateCw,
  Bell,
  BellRing,
  BellOff,
  VolumeX,
  Volume2,
  Cpu,
  Radio,
  Layers,
  Clock,
  AlertCircle,
  CheckCircle2,
  Activity,
  HardDrive,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts'
import './App.css'

// Determine API base URL dynamically
const getApiBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    let url = import.meta.env.VITE_API_URL.trim().replace(/\/+$/, '')
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`
    }
    return url
  }
  // If running via Vite dev server on port 5173, use Vite proxy
  if (window.location.port === '5173') {
    return ''
  }
  // Otherwise default to current hostname on port 8000
  return `http://${window.location.hostname || 'localhost'}:8000`
}

const API_BASE = getApiBaseUrl()

// Format helpers
const formatTime = (ts) => {
  if (!ts) return '--:--:--'
  try {
    const d = new Date(ts.endsWith('Z') || ts.includes('+') ? ts : `${ts}Z`)
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString([], { hour12: true })
  } catch {
    return String(ts)
  }
}

const formatFullDateTime = (ts) => {
  if (!ts) return 'No readings yet'
  try {
    const d = new Date(ts.endsWith('Z') || ts.includes('+') ? ts : `${ts}Z`)
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleString()
  } catch {
    return String(ts)
  }
}

// Custom Chart Tooltip declared outside component to prevent re-creation during render
const CustomChartTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    return (
      <div className="custom-chart-tooltip">
        <div className="tooltip-time">Time: {data.time}</div>
        <div className="tooltip-row">
          <span>Rain Status:</span>
          <span
            className="tooltip-val"
            style={{ color: data.rainStatus === 'RAIN' ? 'var(--alert-red)' : 'var(--safe-green)' }}
          >
            {data.rainStatus}
          </span>
        </div>
        <div className="tooltip-row">
          <span>DO Pin Value:</span>
          <span className="tooltip-val">
            {data.sensorValue} ({data.sensorValue === 0 ? 'LOW / Wet' : 'HIGH / Dry'})
          </span>
        </div>
        <div className="tooltip-row">
          <span>Buzzer:</span>
          <span className="tooltip-val">{data.buzzer}</span>
        </div>
        <div className="tooltip-row">
          <span>LEDs (Red/Green):</span>
          <span className="tooltip-val">{data.redLed} / {data.greenLed}</span>
        </div>
      </div>
    )
  }
  return null
}

function App() {
  const [readings, setReadings] = useState([])
  const [stats, setStats] = useState({
    total_readings: 0,
    rain_readings: 0,
    dry_readings: 0,
    latest_reading: null,
    alarm_status: 'ACTIVE',
    is_silenced: false
  })
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [errorMessage, setErrorMessage] = useState(null)
  const [nowTime, setNowTime] = useState(() => Date.now())

  // Alarm action state
  const [isSilencing, setIsSilencing] = useState(false)
  const [alarmFeedback, setAlarmFeedback] = useState(null)

  const isFetchingRef = useRef(false)

  // Fetch telemetry and stats from FastAPI
  const fetchData = useCallback(async (isManual = false) => {
    if (isFetchingRef.current) return
    isFetchingRef.current = true

    if (isManual) setIsRefreshing(true)

    try {
      // Concurrently fetch recent readings, stats, and alarm status
      const [readingsRes, statsRes] = await Promise.all([
        axios.get(`${API_BASE}/api/sensor-data?limit=50`, { timeout: 3500 }),
        axios.get(`${API_BASE}/api/sensor-data/stats`, { timeout: 3500 }).catch(() => null)
      ])

      const dataList = Array.isArray(readingsRes.data) ? readingsRes.data : []
      setReadings(dataList)

      if (statsRes && statsRes.data) {
        setStats(statsRes.data)
      } else {
        // Fallback calculation if stats endpoint wasn't reached
        const total = dataList.length
        const rainCount = dataList.filter(r => r.rain_status === 'RAIN').length
        setStats(prev => ({
          ...prev,
          total_readings: total,
          rain_readings: rainCount,
          dry_readings: total - rainCount,
          latest_reading: dataList[0] || null
        }))
      }

      setIsConnected(true)
      setErrorMessage(null)
      const current = new Date()
      setLastUpdated(current)
      setNowTime(current.getTime())
    } catch (error) {
      console.warn('Backend fetch error:', error.message)
      setIsConnected(false)
      setErrorMessage(
        'Unable to communicate with FastAPI backend. Showing cached data; reconnecting automatically...'
      )
    } finally {
      setIsLoading(false)
      if (isManual) setIsRefreshing(false)
      isFetchingRef.current = false
    }
  }, [])

  // Setup 2-second real-time polling interval with proper cleanup
  useEffect(() => {
    let isMounted = true
    const runInitialFetch = async () => {
      if (isMounted) {
        await fetchData()
      }
    }
    runInitialFetch()

    const intervalId = setInterval(() => {
      if (isMounted) {
        fetchData()
      }
    }, 2000)

    return () => {
      isMounted = false
      clearInterval(intervalId)
    }
  }, [fetchData])

  // Handle Silence Alarm button click
  const handleSilenceAlarm = async () => {
    if (isSilencing) return
    setIsSilencing(true)
    setAlarmFeedback(null)

    try {
      const response = await axios.post(`${API_BASE}/api/alarm/silence`)
      if (response.data && response.data.status === 'success') {
        setStats(prev => ({
          ...prev,
          alarm_status: 'SILENCED',
          is_silenced: true
        }))
        setAlarmFeedback({
          type: 'success',
          message: 'Alarm silenced! Command dispatched to NodeMCU to mute physical buzzer.'
        })
      }
    } catch (error) {
      console.error('Error silencing alarm:', error)
      setAlarmFeedback({
        type: 'error',
        message: `Failed to silence alarm: ${error.response?.data?.detail || error.message}`
      })
    } finally {
      setIsSilencing(false)
      // Auto-clear feedback after 5 seconds
      setTimeout(() => {
        setAlarmFeedback(null)
      }, 5000)
    }
  }

  // Compute latest reading from state
  const latestReading = readings.length > 0 ? readings[0] : (stats.latest_reading || null)
  const isRain = latestReading && latestReading.rain_status === 'RAIN'

  // Determine current effective alarm status
  const isAlarmSilenced = stats.is_silenced || stats.alarm_status === 'SILENCED'
  const displayAlarmStatus = isRain
    ? (isAlarmSilenced ? 'SILENCED' : 'ACTIVE')
    : 'STANDBY'

  // Calculate NodeMCU hardware connection status (active if reading received in last 25 seconds)
  const isHardwareActive = (() => {
    if (!latestReading || !latestReading.timestamp) return false
    try {
      const readingTime = new Date(
        latestReading.timestamp.endsWith('Z') || latestReading.timestamp.includes('+')
          ? latestReading.timestamp
          : `${latestReading.timestamp}Z`
      ).getTime()
      return isConnected && Math.abs(nowTime - readingTime) < 25000
    } catch {
      return isConnected
    }
  })()

  // Prepare chart data: take latest 20 readings and reverse so oldest is left, newest is right
  const chartData = readings
    .slice(0, 20)
    .reverse()
    .map((r) => ({
      id: r.id,
      time: formatTime(r.timestamp),
      sensorValue: r.sensor_value,
      rainStatus: r.rain_status,
      isRain: r.rain_status === 'RAIN' ? 1 : 0,
      fullTime: formatFullDateTime(r.timestamp),
      buzzer: r.buzzer_status,
      redLed: r.red_led_status,
      greenLed: r.green_led_status
    }))

  return (
    <div className="dashboard-wrapper">
      {/* SECTION A: HEADER */}
      <header className="header-card">
        <div className="header-left">
          <div className="header-icon-box">
            <Droplets size={28} />
          </div>
          <div className="header-titles">
            <h1>Smart Rain Alert System</h1>
            <p>IoT Monitoring & Remote Control Dashboard • NodeMCU ESP8266</p>
          </div>
        </div>

        <div className="header-right">
          {/* Backend Connection Indicator */}
          <div className={`badge-pill ${isConnected ? 'badge-connected' : 'badge-disconnected'}`}>
            <span className={`beacon-dot ${isConnected ? 'connected' : 'disconnected'}`} />
            {isConnected ? (
              <>
                <Wifi size={15} /> Backend Connected
              </>
            ) : (
              <>
                <WifiOff size={15} /> Backend Offline
              </>
            )}
          </div>

          {/* Last Updated Time */}
          <div className="last-updated">
            <Clock size={13} />
            <span>
              {isLoading
                ? 'Loading telemetry...'
                : lastUpdated
                ? lastUpdated.toLocaleTimeString()
                : 'Connecting...'}
            </span>
          </div>

          {/* Refresh Button */}
          <button
            className="btn-refresh"
            onClick={() => fetchData(true)}
            disabled={isRefreshing}
            title="Fetch latest telemetry immediately"
          >
            <RotateCw size={14} className={isRefreshing ? 'spin-icon' : ''} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Disconnection Banner if backend goes offline */}
      {errorMessage && (
        <div className="disconnection-banner">
          <AlertCircle size={18} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* SECTION: REMOTE ALARM CONTROL (SECTION 3 & 7) */}
      <section
        className={`alarm-control-card ${
          displayAlarmStatus === 'ACTIVE'
            ? 'state-active'
            : displayAlarmStatus === 'SILENCED'
            ? 'state-silenced'
            : 'state-standby'
        }`}
      >
        <div className="alarm-card-header">
          <div className="alarm-header-left">
            <div
              className={`alarm-header-icon ${
                displayAlarmStatus === 'ACTIVE'
                  ? 'active'
                  : displayAlarmStatus === 'SILENCED'
                  ? 'silenced'
                  : 'standby'
              }`}
            >
              {displayAlarmStatus === 'ACTIVE' ? (
                <ShieldAlert size={24} />
              ) : displayAlarmStatus === 'SILENCED' ? (
                <BellOff size={24} />
              ) : (
                <ShieldCheck size={24} />
              )}
            </div>
            <div className="alarm-header-titles">
              <h3>Remote Alarm Control Center</h3>
              <p>Mute buzzer remotely while maintaining active rain detection & LED visual warnings</p>
            </div>
          </div>

          {/* Primary Alarm Status Badge */}
          <div
            className={`status-badge ${
              displayAlarmStatus === 'ACTIVE'
                ? 'on-red'
                : displayAlarmStatus === 'SILENCED'
                ? 'on-buzzer'
                : 'on-green'
            }`}
            style={{ fontSize: '13px', padding: '6px 14px' }}
          >
            {displayAlarmStatus === 'ACTIVE' ? (
              <>
                <BellRing size={15} /> ALARM ACTIVE
              </>
            ) : displayAlarmStatus === 'SILENCED' ? (
              <>
                <VolumeX size={15} /> ALARM SILENCED
              </>
            ) : (
              <>
                <CheckCircle2 size={15} /> SYSTEM ARMED (STANDBY)
              </>
            )}
          </div>
        </div>

        {/* 5 Hardware Parameters Strip */}
        <div className="alarm-telemetry-strip">
          {/* 1. Rain Status */}
          <div className="telemetry-cell">
            <span className="cell-label">Rain Status</span>
            <div className="cell-value-row">
              {isRain ? (
                <span style={{ color: 'var(--alert-red)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <CloudRain size={16} /> RAIN DETECTED
                </span>
              ) : (
                <span style={{ color: 'var(--safe-green)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <CloudSun size={16} /> NO RAIN
                </span>
              )}
            </div>
          </div>

          {/* 2. Buzzer Status */}
          <div className="telemetry-cell">
            <span className="cell-label">Piezo Buzzer (D1)</span>
            <div className="cell-value-row">
              {latestReading?.buzzer_status === 'ON' ? (
                <span style={{ color: '#E65100', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <Volume2 size={16} /> ON (SOUNDING)
                </span>
              ) : (
                <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <VolumeX size={16} /> OFF (SILENT)
                </span>
              )}
            </div>
          </div>

          {/* 3. Red LED Status */}
          <div className="telemetry-cell">
            <span className="cell-label">Red LED (Pin D6)</span>
            <div className="cell-value-row">
              <span className={`led-dot ${latestReading?.red_led_status === 'ON' ? 'red-on' : 'off'}`} />
              <span>{latestReading?.red_led_status || 'OFF'}</span>
            </div>
          </div>

          {/* 4. Green LED Status */}
          <div className="telemetry-cell">
            <span className="cell-label">Green LED (Pin D7)</span>
            <div className="cell-value-row">
              <span className={`led-dot ${latestReading?.green_led_status === 'ON' ? 'green-on' : 'off'}`} />
              <span>{latestReading?.green_led_status || 'OFF'}</span>
            </div>
          </div>

          {/* 5. Alarm Mode */}
          <div className="telemetry-cell">
            <span className="cell-label">Alarm Mode</span>
            <div className="cell-value-row">
              <span style={{ fontWeight: 800 }}>
                {isRain ? (isAlarmSilenced ? 'SILENCED' : 'ACTIVE') : 'READY'}
              </span>
            </div>
          </div>
        </div>

        {/* Action Row: SILENCE ALARM Button & Instructions */}
        <div className="alarm-action-container">
          <div className="alarm-action-left">
            <button
              className={`btn-silence-alarm ${
                isRain && !isAlarmSilenced
                  ? 'btn-enabled'
                  : isRain && isAlarmSilenced
                  ? 'btn-silenced'
                  : 'btn-disabled'
              }`}
              onClick={handleSilenceAlarm}
              disabled={!isRain || isAlarmSilenced || isSilencing}
              title={
                !isRain
                  ? 'Sensor is dry. Silence control activates when rain is detected.'
                  : isAlarmSilenced
                  ? 'Alarm is already silenced. It will re-arm automatically when dry.'
                  : 'Click to turn off the physical buzzer immediately.'
              }
            >
              {isSilencing ? (
                <>
                  <RotateCw size={17} className="spin-icon" /> Silencing Buzzer...
                </>
              ) : isRain && isAlarmSilenced ? (
                <>
                  <BellOff size={17} /> ALARM SILENCED
                </>
              ) : (
                <>
                  <VolumeX size={17} /> SILENCE ALARM
                </>
              )}
            </button>

            <span className="alarm-instruction-text">
              {!isRain ? (
                'Sensor surface is dry. Buzzer is idle. The system will automatically arm and sound when precipitation is detected.'
              ) : isAlarmSilenced ? (
                'Buzzer muted remotely. Red warning LED remains ON. When rainfall stops, the alarm will automatically re-arm for subsequent rain events.'
              ) : (
                'Rain detected! Buzzer is sounding. Click SILENCE ALARM to mute the acoustic buzzer while keeping LED indicators active.'
              )}
            </span>
          </div>

          {/* Feedback badge */}
          {alarmFeedback && (
            <div className={`alarm-feedback-toast ${alarmFeedback.type}`}>
              {alarmFeedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              <span>{alarmFeedback.message}</span>
            </div>
          )}
        </div>
      </section>

      {/* TOP ROW: SECTION B (CURRENT RAIN STATUS) & SECTION D (DEVICE HARDWARE STATUS) */}
      <div className="top-status-grid">
        {/* SECTION B: CURRENT RAIN STATUS */}
        <section className={`rain-hero-card ${isRain ? 'rain-active' : 'rain-dry'}`}>
          <div className="hero-meta-top">
            <span className="section-label">Real-Time Sensor State</span>
            <span className="device-chip">
              <Cpu size={13} />
              {latestReading?.device_id || 'NodeMCU ESP8266'}
            </span>
          </div>

          <div className="hero-center-content">
            <div className={`hero-icon-large ${isRain ? 'rain' : 'dry'}`}>
              {isRain ? <CloudRain size={52} strokeWidth={2.3} /> : <CloudSun size={52} strokeWidth={2.3} />}
            </div>

            <div className={`hero-text-block ${isRain ? 'rain' : 'dry'}`}>
              <h2>{isRain ? 'RAIN DETECTED' : 'NO RAIN'}</h2>
              <p>
                {isRain
                  ? 'Precipitation detected on raindrop sensor plate. Alert system active.'
                  : 'Sensor plate is dry and clear. Environmental conditions normal.'}
              </p>
            </div>
          </div>

          <div className="hero-footer-info">
            <div className="reading-timestamp">
              <Activity size={14} />
              <span>
                Timestamp: <strong>{formatFullDateTime(latestReading?.timestamp)}</strong>
              </span>
            </div>
            <div className="hardware-summary-pill">
              {isRain
                ? isAlarmSilenced
                  ? 'Red LED: ON • Green: OFF • Buzzer: SILENCED'
                  : 'Red LED: ON • Green: OFF • Buzzer: ON'
                : 'Red LED: OFF • Green: ON • Buzzer: OFF'}
            </div>
          </div>
        </section>

        {/* SECTION D: DEVICE STATUS */}
        <section className="device-status-card">
          <div className="hero-meta-top">
            <span className="section-label">Hardware Peripheral Status</span>
            <span className="device-chip">Pin Mappings</span>
          </div>

          <div className="device-grid-4">
            {/* NodeMCU ESP8266 */}
            <div className="device-subcard">
              <div className="subcard-header">
                <div className="subcard-title-group">
                  <Cpu size={16} className="subcard-icon" />
                  <span className="subcard-name">NodeMCU ESP8266</span>
                </div>
                <span className="subcard-pin">Wi-Fi HTTP</span>
              </div>
              <div className="subcard-status-row">
                <span className="subcard-desc">Telemetry Link</span>
                <span className={`status-badge ${isHardwareActive ? 'on-green' : 'off-state'}`}>
                  {isHardwareActive ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
            </div>

            {/* Red LED */}
            <div className="device-subcard">
              <div className="subcard-header">
                <div className="subcard-title-group">
                  <div className={`led-dot ${latestReading?.red_led_status === 'ON' ? 'red-on' : 'off'}`} />
                  <span className="subcard-name">Red Alert LED</span>
                </div>
                <span className="subcard-pin">Pin D6</span>
              </div>
              <div className="subcard-status-row">
                <span className="subcard-desc">Rain Alert Output</span>
                <span className={`status-badge ${latestReading?.red_led_status === 'ON' ? 'on-red' : 'off-state'}`}>
                  {latestReading?.red_led_status || 'OFF'}
                </span>
              </div>
            </div>

            {/* Green LED */}
            <div className="device-subcard">
              <div className="subcard-header">
                <div className="subcard-title-group">
                  <div className={`led-dot ${latestReading?.green_led_status === 'ON' ? 'green-on' : 'off'}`} />
                  <span className="subcard-name">Green Safe LED</span>
                </div>
                <span className="subcard-pin">Pin D7</span>
              </div>
              <div className="subcard-status-row">
                <span className="subcard-desc">Clear Weather Output</span>
                <span className={`status-badge ${latestReading?.green_led_status === 'ON' ? 'on-green' : 'off-state'}`}>
                  {latestReading?.green_led_status || 'OFF'}
                </span>
              </div>
            </div>

            {/* Buzzer */}
            <div className="device-subcard">
              <div className="subcard-header">
                <div className="subcard-title-group">
                  {latestReading?.buzzer_status === 'ON' ? (
                    <BellRing size={16} className="subcard-icon" style={{ color: '#E65100' }} />
                  ) : (
                    <Bell size={16} className="subcard-icon" />
                  )}
                  <span className="subcard-name">Piezo Buzzer</span>
                </div>
                <span className="subcard-pin">Pin D1 (Active-LOW)</span>
              </div>
              <div className="subcard-status-row">
                <span className="subcard-desc">Acoustic Alert</span>
                <span
                  className={`status-badge ${
                    latestReading?.buzzer_status === 'ON' ? 'on-buzzer' : 'off-state'
                  }`}
                >
                  {latestReading?.buzzer_status || 'OFF'}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* SECTION C: STATISTICS CARDS */}
      <section className="stats-grid">
        {/* Latest Sensor Value */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-title">Latest Sensor Value</span>
            <div className="stat-icon-wrap olive">
              <Radio size={19} />
            </div>
          </div>
          <div className="stat-body">
            <span className="stat-number">
              {latestReading !== null && latestReading !== undefined ? latestReading.sensor_value : '--'}
            </span>
            <span className="stat-unit">
              {latestReading?.sensor_value === 0 ? '(0 = Rain LOW)' : '(1 = Dry HIGH)'}
            </span>
          </div>
          <div className="stat-footer-text">
            <span>Digital DO Pin D5 active-low logic</span>
          </div>
        </div>

        {/* Total Sensor Readings */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-title">Total Sensor Readings</span>
            <div className="stat-icon-wrap blue">
              <Layers size={19} />
            </div>
          </div>
          <div className="stat-body">
            <span className="stat-number">{stats.total_readings.toLocaleString()}</span>
            <span className="stat-unit">logs</span>
          </div>
          <div className="stat-footer-text">
            <HardDrive size={12} />
            <span>Persisted in SQLite database</span>
          </div>
        </div>

        {/* Total Rain Readings */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-title">Total Rain Readings</span>
            <div className="stat-icon-wrap red">
              <CloudRain size={19} />
            </div>
          </div>
          <div className="stat-body">
            <span className="stat-number">{stats.rain_readings.toLocaleString()}</span>
            <span className="stat-unit">
              {stats.total_readings > 0
                ? `(${((stats.rain_readings / stats.total_readings) * 100).toFixed(1)}%)`
                : ''}
            </span>
          </div>
          <div className="stat-footer-text">
            <span>Wet precipitation events detected</span>
          </div>
        </div>

        {/* Total Dry Readings */}
        <div className="stat-card">
          <div className="stat-header">
            <span className="stat-title">Total Dry Readings</span>
            <div className="stat-icon-wrap green">
              <Sun size={19} />
            </div>
          </div>
          <div className="stat-body">
            <span className="stat-number">{stats.dry_readings.toLocaleString()}</span>
            <span className="stat-unit">
              {stats.total_readings > 0
                ? `(${((stats.dry_readings / stats.total_readings) * 100).toFixed(1)}%)`
                : ''}
            </span>
          </div>
          <div className="stat-footer-text">
            <span>Dry and clear weather states</span>
          </div>
        </div>
      </section>

      {/* SECTION E: LIVE SENSOR CHART */}
      <section className="chart-card">
        <div className="chart-header">
          <div className="chart-title-group">
            <h3>Live Sensor Chart</h3>
            <p>Digital Output (DO) signal transitions over the latest 20 readings (0 = Rain, 1 = Dry)</p>
          </div>
          <div className="chart-legend-pills">
            <span className="chart-pill">
              <span className="chart-pill-dot" style={{ backgroundColor: 'var(--alert-red)' }} />
              Rain (Value 0)
            </span>
            <span className="chart-pill">
              <span className="chart-pill-dot" style={{ backgroundColor: 'var(--safe-green)' }} />
              Dry (Value 1)
            </span>
          </div>
        </div>

        <div className="chart-container-box">
          {chartData.length === 0 ? (
            <div className="empty-state-box">
              <Activity size={32} />
              <h4>No telemetry available for chart</h4>
              <p>Waiting for sensor readings from the ESP8266 or FastAPI backend...</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="sensorGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4B6E4E" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#8FA891" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E7E3D8" vertical={false} />
                <XAxis
                  dataKey="time"
                  stroke="#839185"
                  fontSize={11}
                  tickLine={false}
                  dy={6}
                />
                <YAxis
                  domain={[0, 1]}
                  ticks={[0, 1]}
                  tickFormatter={(val) => (val === 0 ? '0 Rain' : '1 Dry')}
                  stroke="#839185"
                  fontSize={11}
                  tickLine={false}
                />
                <Tooltip content={<CustomChartTooltip />} />
                <Area
                  type="stepAfter"
                  dataKey="sensorValue"
                  stroke="#384F3B"
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#sensorGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* SECTION F: RECENT SENSOR READINGS TABLE */}
      <section className="table-card">
        <div className="table-header">
          <div className="table-title-group">
            <h3>Recent Sensor Readings</h3>
            <p>Displaying the latest 10 records recorded in SQLite (newest first)</p>
          </div>
          <span className="section-label">Auto-Refreshed every 2s</span>
        </div>

        <div className="table-responsive-wrapper">
          {readings.length === 0 ? (
            <div className="empty-state-box">
              <CheckCircle2 size={32} />
              <h4>No readings logged yet</h4>
              <p>Connect your NodeMCU ESP8266 to Wi-Fi to start streaming telemetry.</p>
            </div>
          ) : (
            <table className="sensor-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Timestamp</th>
                  <th>Device</th>
                  <th>Sensor Value</th>
                  <th>Rain Status</th>
                  <th>Red LED (D6)</th>
                  <th>Green LED (D7)</th>
                  <th>Buzzer (D1)</th>
                </tr>
              </thead>
              <tbody>
                {readings.slice(0, 10).map((reading) => {
                  const isReadingRain = reading.rain_status === 'RAIN'
                  return (
                    <tr key={reading.id} className={isReadingRain ? 'row-rain' : ''}>
                      <td className="table-mono-id">#{reading.id}</td>
                      <td className="table-timestamp">{formatFullDateTime(reading.timestamp)}</td>
                      <td>
                        <span className="device-chip" style={{ fontSize: '11px', padding: '2px 6px' }}>
                          {reading.device_id || 'NodeMCU'}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                          {reading.sensor_value} ({reading.sensor_value === 0 ? 'LOW' : 'HIGH'})
                        </span>
                      </td>
                      <td>
                        <span className={`table-badge ${isReadingRain ? 'rain' : 'dry'}`}>
                          {isReadingRain ? <CloudRain size={13} /> : <CloudSun size={13} />}
                          {reading.rain_status}
                        </span>
                      </td>
                      <td>
                        <span className="led-indicator">
                          <span className={`led-dot ${reading.red_led_status === 'ON' ? 'red-on' : 'off'}`} />
                          {reading.red_led_status}
                        </span>
                      </td>
                      <td>
                        <span className="led-indicator">
                          <span className={`led-dot ${reading.green_led_status === 'ON' ? 'green-on' : 'off'}`} />
                          {reading.green_led_status}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`status-badge ${
                            reading.buzzer_status === 'ON' ? 'on-buzzer' : 'off-state'
                          }`}
                          style={{ fontSize: '11px', padding: '2px 8px' }}
                        >
                          {reading.buzzer_status}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* FOOTER & SYSTEM ARCHITECTURE SUMMARY */}
      <footer className="footer-details">
        <div className="hardware-specs-list">
          <div className="spec-item">
            <span>Rain Sensor:</span>
            <span className="spec-badge">DO → Pin D5 (Active LOW)</span>
          </div>
          <div className="spec-item">
            <span>Buzzer:</span>
            <span className="spec-badge">Pin D1 (Active LOW: LOW=ON)</span>
          </div>
          <div className="spec-item">
            <span>LEDs:</span>
            <span className="spec-badge">Red: D6 | Green: D7</span>
          </div>
          <div className="spec-item">
            <span>Alarm Logic:</span>
            <span className="spec-badge">Auto Re-arm on Dry</span>
          </div>
        </div>

        <div className="academic-badge">Smart Rain Alert System • Remote Alarm Control Demo</div>
      </footer>
    </div>
  )
}

export default App
