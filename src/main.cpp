#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <math.h>

namespace {
constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint8_t ADC_BITS = 12;
constexpr uint16_t ADC_MAX = (1U << ADC_BITS) - 1;
constexpr uint16_t SATURATION_MARGIN = 20;
constexpr size_t MAX_PIECEWISE_POINTS = 12;

struct MeasurementConfig {
  uint8_t ledPin = 25;
  uint8_t adcPin = 34;  // ADC1_CH6; compatible with Wi-Fi.
  uint32_t settleUs = 100;
  uint32_t halfPeriodUs = 800;
  uint16_t readsPerState = 2;
  uint16_t cyclesPerResult = 32;
  uint32_t resultIntervalMs = 500;
  bool saveCalibration = true;
  bool offMinusOn = true;
};

enum class CalibrationType : uint8_t { None, Linear, Quadratic, Piecewise };

struct Calibration {
  CalibrationType type = CalibrationType::None;
  double a = 0.0;
  double b = 0.0;
  double c = 0.0;
  double validMinMv = 0.0;
  double validMaxMv = 0.0;
  uint8_t pointCount = 0;
  double deltaMv[MAX_PIECEWISE_POINTS]{};
  double ntu[MAX_PIECEWISE_POINTS]{};
};

enum class AcquisitionState : uint8_t { Idle, WaitOn, ReadOn, HoldOn, WaitOff, ReadOff, HoldOff, WaitInterval };

MeasurementConfig config;
Calibration calibration;
Preferences preferences;
AcquisitionState state = AcquisitionState::Idle;
bool running = true;
uint32_t deadlineUs = 0;
uint32_t phaseEndUs = 0;
uint32_t nextResultMs = 0;
uint32_t measurementNumber = 0;
uint16_t cycleCount = 0;
uint16_t readCount = 0;
double stateSumMv = 0.0;
double cycleOnMv = 0.0;
double sumOnMv = 0.0;
double sumOffMv = 0.0;
double sumDeltaMv = 0.0;
double sumDeltaSq = 0.0;
double minDeltaMv = INFINITY;
double maxDeltaMv = -INFINITY;
bool saturated = false;
bool timingOverrun = false;

bool elapsedUs(uint32_t now, uint32_t target) {
  return static_cast<int32_t>(now - target) >= 0;
}

const char *calibrationName(CalibrationType type) {
  switch (type) {
    case CalibrationType::Linear: return "linear";
    case CalibrationType::Quadratic: return "quadratic";
    case CalibrationType::Piecewise: return "piecewise";
    default: return "none";
  }
}

CalibrationType parseCalibrationType(const char *value) {
  if (!strcmp(value, "linear")) return CalibrationType::Linear;
  if (!strcmp(value, "quadratic")) return CalibrationType::Quadratic;
  if (!strcmp(value, "piecewise")) return CalibrationType::Piecewise;
  return CalibrationType::None;
}

void resetAccumulator() {
  cycleCount = 0;
  readCount = 0;
  stateSumMv = 0.0;
  sumOnMv = 0.0;
  sumOffMv = 0.0;
  sumDeltaMv = 0.0;
  sumDeltaSq = 0.0;
  minDeltaMv = INFINITY;
  maxDeltaMv = -INFINITY;
  saturated = false;
  timingOverrun = false;
}

void beginCycle() {
  digitalWrite(config.ledPin, HIGH);
  readCount = 0;
  stateSumMv = 0.0;
  const uint32_t phaseStartUs = micros();
  deadlineUs = phaseStartUs + config.settleUs;
  phaseEndUs = phaseStartUs + config.halfPeriodUs;
  state = AcquisitionState::WaitOn;
}

double applyCalibration(double deltaMv, bool &valid, bool &extrapolated) {
  valid = calibration.type != CalibrationType::None;
  extrapolated = false;
  if (!valid) return NAN;
  extrapolated = deltaMv < calibration.validMinMv || deltaMv > calibration.validMaxMv;
  if (calibration.type == CalibrationType::Linear) return calibration.a * deltaMv + calibration.b;
  if (calibration.type == CalibrationType::Quadratic) {
    return calibration.a * deltaMv * deltaMv + calibration.b * deltaMv + calibration.c;
  }
  if (calibration.pointCount < 2) {
    valid = false;
    return NAN;
  }
  uint8_t upper = 1;
  while (upper < calibration.pointCount && deltaMv > calibration.deltaMv[upper]) ++upper;
  if (upper >= calibration.pointCount) upper = calibration.pointCount - 1;
  const uint8_t lower = upper - 1;
  const double span = calibration.deltaMv[upper] - calibration.deltaMv[lower];
  if (fabs(span) < 1e-12) {
    valid = false;
    return NAN;
  }
  const double fraction = (deltaMv - calibration.deltaMv[lower]) / span;
  return calibration.ntu[lower] + fraction * (calibration.ntu[upper] - calibration.ntu[lower]);
}

void emitStatus(const char *event, bool ok = true, const char *message = nullptr) {
  JsonDocument doc;
  doc["type"] = "status";
  doc["event"] = event;
  doc["ok"] = ok;
  if (message) doc["message"] = message;
  serializeJson(doc, Serial);
  Serial.println();
}

void emitMeasurement() {
  const double n = cycleCount;
  const double meanOn = sumOnMv / n;
  const double meanOff = sumOffMv / n;
  const double meanDelta = sumDeltaMv / n;
  double variance = 0.0;
  if (cycleCount > 1) variance = (sumDeltaSq - sumDeltaMv * sumDeltaMv / n) / (n - 1.0);
  const double stddev = sqrt(fmax(0.0, variance));
  const double snr = stddev > 0.0 ? fabs(meanDelta) / stddev : NAN;
  bool calibrated = false;
  bool extrapolated = false;
  const double ntu = applyCalibration(meanDelta, calibrated, extrapolated);

  JsonDocument doc;
  doc["type"] = "measurement";
  doc["sequence"] = ++measurementNumber;
  doc["uptime_ms"] = millis();
  doc["v_on_mv"] = serialized(String(meanOn, 3));
  doc["v_off_mv"] = serialized(String(meanOff, 3));
  doc["delta_mv"] = serialized(String(meanDelta, 3));
  doc["stddev_mv"] = serialized(String(stddev, 3));
  doc["min_mv"] = serialized(String(minDeltaMv, 3));
  doc["max_mv"] = serialized(String(maxDeltaMv, 3));
  if (isfinite(snr)) doc["snr"] = serialized(String(snr, 3));
  else doc["snr"] = nullptr;
  doc["cycles"] = cycleCount;
  doc["adc_samples"] = static_cast<uint32_t>(cycleCount) * config.readsPerState * 2U;
  doc["saturated"] = saturated;
  doc["timing_overrun"] = timingOverrun;
  doc["delta_definition"] = config.offMinusOn ? "v_off-v_on" : "v_on-v_off";
  doc["calibrated"] = calibrated;
  doc["calibration_type"] = calibrationName(calibration.type);
  doc["extrapolated"] = extrapolated;
  if (calibrated && isfinite(ntu)) doc["ntu"] = serialized(String(ntu, 3));
  else doc["ntu"] = nullptr;
  serializeJson(doc, Serial);
  Serial.println();
}

void saveCalibration() {
  if (!config.saveCalibration) return;
  preferences.begin("turbidimeter", false);
  preferences.putUChar("calType", static_cast<uint8_t>(calibration.type));
  preferences.putDouble("calA", calibration.a);
  preferences.putDouble("calB", calibration.b);
  preferences.putDouble("calC", calibration.c);
  preferences.putDouble("calMin", calibration.validMinMv);
  preferences.putDouble("calMax", calibration.validMaxMv);
  preferences.putUChar("calN", calibration.pointCount);
  preferences.putBytes("calX", calibration.deltaMv, sizeof(calibration.deltaMv));
  preferences.putBytes("calY", calibration.ntu, sizeof(calibration.ntu));
  preferences.end();
}

void loadCalibration() {
  preferences.begin("turbidimeter", true);
  calibration.type = static_cast<CalibrationType>(preferences.getUChar("calType", 0));
  calibration.a = preferences.getDouble("calA", 0.0);
  calibration.b = preferences.getDouble("calB", 0.0);
  calibration.c = preferences.getDouble("calC", 0.0);
  calibration.validMinMv = preferences.getDouble("calMin", 0.0);
  calibration.validMaxMv = preferences.getDouble("calMax", 0.0);
  calibration.pointCount = min<uint8_t>(preferences.getUChar("calN", 0), MAX_PIECEWISE_POINTS);
  preferences.getBytes("calX", calibration.deltaMv, sizeof(calibration.deltaMv));
  preferences.getBytes("calY", calibration.ntu, sizeof(calibration.ntu));
  preferences.end();
}

bool validAdc1Pin(uint8_t pin) {
  return pin == 32 || pin == 33 || pin == 34 || pin == 35 || pin == 36 || pin == 39;
}

void applyPinConfiguration(uint8_t oldLedPin) {
  if (oldLedPin != config.ledPin) {
    digitalWrite(oldLedPin, LOW);
    pinMode(oldLedPin, INPUT);
  }
  pinMode(config.ledPin, OUTPUT);
  digitalWrite(config.ledPin, LOW);
  pinMode(config.adcPin, INPUT);
  analogSetPinAttenuation(config.adcPin, ADC_11db);
}

void sendConfiguration() {
  JsonDocument doc;
  doc["type"] = "config";
  doc["led_pin"] = config.ledPin;
  doc["adc_pin"] = config.adcPin;
  doc["settle_us"] = config.settleUs;
  doc["half_period_us"] = config.halfPeriodUs;
  doc["reads_per_state"] = config.readsPerState;
  doc["cycles_per_result"] = config.cyclesPerResult;
  doc["result_interval_ms"] = config.resultIntervalMs;
  doc["save_calibration"] = config.saveCalibration;
  doc["off_minus_on"] = config.offMinusOn;
  serializeJson(doc, Serial);
  Serial.println();
}

void handleCommand(const String &line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) {
    emitStatus("command", false, "JSON invalido");
    return;
  }
  const char *command = doc["cmd"] | "";
  if (!strcmp(command, "start")) {
    running = true;
    state = AcquisitionState::Idle;
    emitStatus("started");
  } else if (!strcmp(command, "stop")) {
    running = false;
    state = AcquisitionState::Idle;
    digitalWrite(config.ledPin, LOW);
    emitStatus("stopped");
  } else if (!strcmp(command, "get_config")) {
    sendConfiguration();
  } else if (!strcmp(command, "set_config")) {
    const uint8_t oldLedPin = config.ledPin;
    const uint8_t requestedAdc = doc["adc_pin"] | config.adcPin;
    if (!validAdc1Pin(requestedAdc)) {
      emitStatus("config", false, "adc_pin debe ser un pin ADC1: 32-36 o 39");
      return;
    }
    config.ledPin = constrain(static_cast<int>(doc["led_pin"] | config.ledPin), 0, 39);
    config.adcPin = requestedAdc;
    const uint32_t requestedSettleUs = constrain(static_cast<uint32_t>(doc["settle_us"] | config.settleUs), 10UL, 1000000UL);
    const uint32_t requestedHalfPeriodUs = constrain(static_cast<uint32_t>(doc["half_period_us"] | config.halfPeriodUs), 20UL, 1000000UL);
    if (requestedSettleUs >= requestedHalfPeriodUs) {
      emitStatus("config", false, "settle_us debe ser menor que half_period_us");
      return;
    }
    config.settleUs = requestedSettleUs;
    config.halfPeriodUs = requestedHalfPeriodUs;
    config.readsPerState = constrain(static_cast<uint16_t>(doc["reads_per_state"] | config.readsPerState), 1, 1024);
    config.cyclesPerResult = constrain(static_cast<uint16_t>(doc["cycles_per_result"] | config.cyclesPerResult), 2, 4096);
    config.resultIntervalMs = constrain(static_cast<uint32_t>(doc["result_interval_ms"] | config.resultIntervalMs), 0UL, 3600000UL);
    config.saveCalibration = doc["save_calibration"] | config.saveCalibration;
    config.offMinusOn = doc["off_minus_on"] | config.offMinusOn;
    applyPinConfiguration(oldLedPin);
    state = AcquisitionState::Idle;
    emitStatus("config_saved");
    sendConfiguration();
  } else if (!strcmp(command, "set_calibration")) {
    calibration.type = parseCalibrationType(doc["model"] | "none");
    calibration.a = doc["a"] | 0.0;
    calibration.b = doc["b"] | 0.0;
    calibration.c = doc["c"] | 0.0;
    calibration.validMinMv = doc["valid_min_mv"] | 0.0;
    calibration.validMaxMv = doc["valid_max_mv"] | 0.0;
    calibration.pointCount = 0;
    JsonArray points = doc["points"].as<JsonArray>();
    for (JsonObject point : points) {
      if (calibration.pointCount >= MAX_PIECEWISE_POINTS) break;
      calibration.deltaMv[calibration.pointCount] = point["delta_mv"] | 0.0;
      calibration.ntu[calibration.pointCount] = point["ntu"] | 0.0;
      ++calibration.pointCount;
    }
    if (calibration.type == CalibrationType::Piecewise && calibration.pointCount < 2) {
      calibration.type = CalibrationType::None;
      emitStatus("calibration", false, "La calibracion por tramos requiere al menos dos puntos");
      return;
    }
    saveCalibration();
    emitStatus("calibration_saved");
  } else if (!strcmp(command, "clear_calibration")) {
    calibration = Calibration{};
    saveCalibration();
    emitStatus("calibration_cleared");
  } else {
    emitStatus("command", false, "Comando desconocido");
  }
}

void pollSerial() {
  static String input;
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n') {
      input.trim();
      if (!input.isEmpty()) handleCommand(input);
      input = "";
    } else if (ch != '\r' && input.length() < 2048) {
      input += ch;
    }
  }
}

void runAcquisition() {
  if (!running) return;
  const uint32_t nowUs = micros();
  switch (state) {
    case AcquisitionState::Idle:
      resetAccumulator();
      beginCycle();
      break;
    case AcquisitionState::WaitOn:
      if (elapsedUs(nowUs, deadlineUs)) state = AcquisitionState::ReadOn;
      break;
    case AcquisitionState::ReadOn: {
      const uint16_t raw = analogRead(config.adcPin);
      stateSumMv += analogReadMilliVolts(config.adcPin);
      saturated |= raw <= SATURATION_MARGIN || raw >= ADC_MAX - SATURATION_MARGIN;
      if (++readCount >= config.readsPerState) {
        cycleOnMv = stateSumMv / readCount;
        timingOverrun |= elapsedUs(micros(), phaseEndUs);
        state = AcquisitionState::HoldOn;
      }
      break;
    }
    case AcquisitionState::HoldOn:
      if (elapsedUs(nowUs, phaseEndUs)) {
        digitalWrite(config.ledPin, LOW);  // HIGH -> PRUEBA TEMPORAL: LED siempre encendido
        readCount = 0;
        stateSumMv = 0.0;
        const uint32_t phaseStartUs = micros();
        deadlineUs = phaseStartUs + config.settleUs;
        phaseEndUs = phaseStartUs + config.halfPeriodUs;
        state = AcquisitionState::WaitOff;
      }
      break;
    case AcquisitionState::WaitOff:
      if (elapsedUs(nowUs, deadlineUs)) state = AcquisitionState::ReadOff;
      break;
    case AcquisitionState::ReadOff: {
      const uint16_t raw = analogRead(config.adcPin);
      stateSumMv += analogReadMilliVolts(config.adcPin);
      saturated |= raw <= SATURATION_MARGIN || raw >= ADC_MAX - SATURATION_MARGIN;
      if (++readCount >= config.readsPerState) {
        const double offMv = stateSumMv / readCount;
        const double deltaMv = config.offMinusOn ? offMv - cycleOnMv : cycleOnMv - offMv;
        sumOnMv += cycleOnMv;
        sumOffMv += offMv;
        sumDeltaMv += deltaMv;
        sumDeltaSq += deltaMv * deltaMv;
        minDeltaMv = fmin(minDeltaMv, deltaMv);
        maxDeltaMv = fmax(maxDeltaMv, deltaMv);
        timingOverrun |= elapsedUs(micros(), phaseEndUs);
        state = AcquisitionState::HoldOff;
      }
      break;
    }
    case AcquisitionState::HoldOff:
      if (elapsedUs(nowUs, phaseEndUs)) {
        if (++cycleCount >= config.cyclesPerResult) {
          emitMeasurement();
          nextResultMs = millis() + config.resultIntervalMs;
          state = AcquisitionState::WaitInterval;
        } else {
          beginCycle();
        }
      }
      break;
    case AcquisitionState::WaitInterval:
      if (static_cast<int32_t>(millis() - nextResultMs) >= 0) state = AcquisitionState::Idle;
      break;
  }
}
}  // namespace

void setup() {
  Serial.begin(SERIAL_BAUD);
  analogReadResolution(ADC_BITS);
  applyPinConfiguration(config.ledPin);
  loadCalibration();
  emitStatus("ready");
  sendConfiguration();
}

void loop() {
  pollSerial();
  runAcquisition();
  yield();
}
