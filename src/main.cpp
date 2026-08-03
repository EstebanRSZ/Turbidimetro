#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <math.h>

namespace {
constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint8_t ADC_BITS = 12;
constexpr uint16_t ADC_SATURATION_LOW_MV = 50;
constexpr uint16_t ADC_SATURATION_HIGH_MV = 3050;
constexpr size_t MAX_PIECEWISE_POINTS = 12;

// Geometria de medicion. No es una etiqueta: cambia la variable optica sobre la
// que se calibra y el significado fisico del blanco de agua.
//   Attenuation   (180 grados) el blanco es la referencia de 100 % de
//                 transmision y se DIVIDE:  T = dV / dV_agua,  A = -log10(T).
//   Nephelometric (90 grados)  el blanco es el offset de luz parasita del
//                 frasco y el agua y se RESTA:  S = dV - dV_agua.
enum class MeasurementMode : uint8_t { Attenuation, Nephelometric };

struct MeasurementConfig {
  uint8_t ledPin = 25;
  uint8_t adcPin = 34;  // ADC1_CH6; compatible with Wi-Fi.
  uint32_t settleUs = 100;
  // 1250 us de semiperiodo => ciclo de 2,5 ms. 100 ciclos son 250 ms, que
  // equivalen a 15 periodos exactos de red de 60 Hz. Al integrar un numero
  // entero de periodos, la interferencia de red y sus armonicos (los focos
  // parpadean a 120 Hz, el segundo armonico) se promedian a cero.
  uint32_t halfPeriodUs = 1250;
  uint16_t readsPerState = 2;
  uint16_t cyclesPerResult = 100;
  uint32_t resultIntervalMs = 500;
  bool saveCalibration = true;
  bool offMinusOn = true;
  MeasurementMode mode = MeasurementMode::Attenuation;
};

enum class CalibrationType : uint8_t { None, Linear, Quadratic, Piecewise };

// La calibracion mapea la variable optica (A a 180 grados, S a 90 grados) a
// concentracion. Antes mapeaba dV directo, lo cual no es lineal por
// Beer-Lambert: la relacion lineal es concentracion contra A, no contra dV.
struct Calibration {
  CalibrationType type = CalibrationType::None;
  double a = 0.0;
  double b = 0.0;
  double c = 0.0;
  double validMin = 0.0;
  double validMax = 0.0;
  uint8_t pointCount = 0;
  double x[MAX_PIECEWISE_POINTS]{};
  double y[MAX_PIECEWISE_POINTS]{};
};

enum class AcquisitionState : uint8_t { Idle, WaitOn, ReadOn, HoldOn, WaitOff, ReadOff, HoldOff, WaitInterval };

MeasurementConfig config;
Calibration calibration;
// Referencia optica de agua limpia. Vive en el ESP32 y se persiste en NVS para
// que sobreviva a una recarga del dashboard.
double blankMv = 0.0;
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

bool adcNearLimit(double millivolts) {
  return millivolts <= ADC_SATURATION_LOW_MV || millivolts >= ADC_SATURATION_HIGH_MV;
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

const char *modeName(MeasurementMode mode) {
  return mode == MeasurementMode::Nephelometric ? "nephelometric" : "attenuation";
}

MeasurementMode parseMode(const char *value) {
  return !strcmp(value, "nephelometric") ? MeasurementMode::Nephelometric
                                         : MeasurementMode::Attenuation;
}

// Variable optica sobre la que se calibra, segun la geometria activa.
// Devuelve NAN si todavia no hay blanco o si la transmitancia no es positiva.
double opticalVariable(double deltaMv) {
  if (!(blankMv > 0.0)) return NAN;
  if (config.mode == MeasurementMode::Nephelometric) return deltaMv - blankMv;
  if (!(deltaMv > 0.0)) return NAN;
  return -log10(deltaMv / blankMv);
}

// decimals es unsigned int, no uint8_t: con uint8_t la llamada a String() se
// vuelve ambigua entre las sobrecargas de punto flotante y las enteras.
void putNumber(JsonDocument &doc, const char *key, double value, unsigned int decimals = 3) {
  if (isfinite(value)) doc[key] = serialized(String(value, decimals));
  else doc[key] = nullptr;
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

// x es la variable optica ya calculada por opticalVariable().
double applyCalibration(double x, bool &valid, bool &extrapolated) {
  valid = calibration.type != CalibrationType::None && isfinite(x);
  extrapolated = false;
  if (!valid) return NAN;
  extrapolated = x < calibration.validMin || x > calibration.validMax;
  if (calibration.type == CalibrationType::Linear) return calibration.a * x + calibration.b;
  if (calibration.type == CalibrationType::Quadratic) {
    return calibration.a * x * x + calibration.b * x + calibration.c;
  }
  if (calibration.pointCount < 2) {
    valid = false;
    return NAN;
  }
  uint8_t upper = 1;
  while (upper < calibration.pointCount && x > calibration.x[upper]) ++upper;
  if (upper >= calibration.pointCount) upper = calibration.pointCount - 1;
  const uint8_t lower = upper - 1;
  const double span = calibration.x[upper] - calibration.x[lower];
  if (fabs(span) < 1e-12) {
    valid = false;
    return NAN;
  }
  const double fraction = (x - calibration.x[lower]) / span;
  return calibration.y[lower] + fraction * (calibration.y[upper] - calibration.y[lower]);
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
  const double optical = opticalVariable(meanDelta);
  bool calibrated = false;
  bool extrapolated = false;
  const double concentration = applyCalibration(optical, calibrated, extrapolated);

  JsonDocument doc;
  doc["type"] = "measurement";
  doc["sequence"] = ++measurementNumber;
  doc["uptime_ms"] = millis();
  doc["mode"] = modeName(config.mode);
  putNumber(doc, "v_on_mv", meanOn);
  putNumber(doc, "v_off_mv", meanOff);
  putNumber(doc, "delta_mv", meanDelta);
  putNumber(doc, "stddev_mv", stddev);
  putNumber(doc, "min_mv", minDeltaMv);
  putNumber(doc, "max_mv", maxDeltaMv);
  putNumber(doc, "snr", snr);
  putNumber(doc, "blank_mv", blankMv > 0.0 ? blankMv : NAN);

  // Solo tiene sentido una de las dos ramas: a 90 grados la senal CRECE con la
  // turbidez, asi que T seria mayor que 1 y A saldria negativa.
  if (config.mode == MeasurementMode::Attenuation) {
    const double transmittance = (blankMv > 0.0 && meanDelta > 0.0) ? meanDelta / blankMv : NAN;
    putNumber(doc, "transmittance_rel", transmittance, 5);
    putNumber(doc, "attenuance", optical, 5);
    doc["net_scatter_mv"] = nullptr;
  } else {
    doc["transmittance_rel"] = nullptr;
    doc["attenuance"] = nullptr;
    putNumber(doc, "net_scatter_mv", optical);
  }

  doc["cycles"] = cycleCount;
  doc["adc_samples"] = static_cast<uint32_t>(cycleCount) * config.readsPerState * 2U;
  doc["saturated"] = saturated;
  doc["timing_overrun"] = timingOverrun;
  doc["delta_definition"] = config.offMinusOn ? "v_off-v_on" : "v_on-v_off";
  doc["calibrated"] = calibrated;
  doc["calibration_type"] = calibrationName(calibration.type);
  doc["extrapolated"] = extrapolated;
  putNumber(doc, "concentration", calibrated ? concentration : NAN);
  serializeJson(doc, Serial);
  Serial.println();
}

// El blanco se guarda aparte de la calibracion: "Borrar calibracion" no debe
// obligar a repetir la referencia de agua.
void saveBlank() {
  if (!config.saveCalibration) return;
  preferences.begin("turbidimeter", false);
  preferences.putDouble("blankMv", blankMv);
  preferences.putUChar("mode", static_cast<uint8_t>(config.mode));
  preferences.end();
}

void saveCalibration() {
  if (!config.saveCalibration) return;
  preferences.begin("turbidimeter", false);
  preferences.putUChar("calType", static_cast<uint8_t>(calibration.type));
  preferences.putDouble("calA", calibration.a);
  preferences.putDouble("calB", calibration.b);
  preferences.putDouble("calC", calibration.c);
  preferences.putDouble("calMin", calibration.validMin);
  preferences.putDouble("calMax", calibration.validMax);
  preferences.putUChar("calN", calibration.pointCount);
  preferences.putBytes("calX", calibration.x, sizeof(calibration.x));
  preferences.putBytes("calY", calibration.y, sizeof(calibration.y));
  preferences.end();
}

void loadCalibration() {
  preferences.begin("turbidimeter", true);
  calibration.type = static_cast<CalibrationType>(preferences.getUChar("calType", 0));
  calibration.a = preferences.getDouble("calA", 0.0);
  calibration.b = preferences.getDouble("calB", 0.0);
  calibration.c = preferences.getDouble("calC", 0.0);
  calibration.validMin = preferences.getDouble("calMin", 0.0);
  calibration.validMax = preferences.getDouble("calMax", 0.0);
  calibration.pointCount = min<uint8_t>(preferences.getUChar("calN", 0), MAX_PIECEWISE_POINTS);
  preferences.getBytes("calX", calibration.x, sizeof(calibration.x));
  preferences.getBytes("calY", calibration.y, sizeof(calibration.y));
  blankMv = preferences.getDouble("blankMv", 0.0);
  config.mode = static_cast<MeasurementMode>(preferences.getUChar("mode", 0));
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
  doc["mode"] = modeName(config.mode);
  putNumber(doc, "blank_mv", blankMv > 0.0 ? blankMv : NAN);
  doc["calibration_type"] = calibrationName(calibration.type);
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
    config.mode = parseMode(doc["mode"] | modeName(config.mode));
    applyPinConfiguration(oldLedPin);
    saveBlank();  // El modo viaja junto al blanco en NVS.
    state = AcquisitionState::Idle;
    emitStatus("config_saved");
    sendConfiguration();
  } else if (!strcmp(command, "set_blank")) {
    // Referencia de agua limpia. A 180 grados es el 100 % de transmision, a
    // 90 grados el offset de luz parasita.
    if (doc["clear"] | false) {
      blankMv = 0.0;
      saveBlank();
      emitStatus("blank_cleared");
      sendConfiguration();
      return;
    }
    const double requestedBlank = doc["blank_mv"] | 0.0;
    if (!(requestedBlank > 0.0) || !isfinite(requestedBlank)) {
      emitStatus("blank", false, "blank_mv debe ser un valor positivo");
      return;
    }
    blankMv = requestedBlank;
    saveBlank();
    emitStatus("blank_saved");
    sendConfiguration();
  } else if (!strcmp(command, "set_calibration")) {
    calibration.type = parseCalibrationType(doc["model"] | "none");
    calibration.a = doc["a"] | 0.0;
    calibration.b = doc["b"] | 0.0;
    calibration.c = doc["c"] | 0.0;
    calibration.validMin = doc["valid_min"] | 0.0;
    calibration.validMax = doc["valid_max"] | 0.0;
    calibration.pointCount = 0;
    JsonArray points = doc["points"].as<JsonArray>();
    for (JsonObject point : points) {
      if (calibration.pointCount >= MAX_PIECEWISE_POINTS) break;
      calibration.x[calibration.pointCount] = point["x"] | 0.0;
      calibration.y[calibration.pointCount] = point["y"] | 0.0;
      ++calibration.pointCount;
    }
    if (calibration.type == CalibrationType::Piecewise && calibration.pointCount < 2) {
      calibration.type = CalibrationType::None;
      emitStatus("calibration", false, "La calibracion por tramos requiere al menos dos puntos");
      return;
    }
    saveCalibration();
    emitStatus("calibration_saved");
    sendConfiguration();
  } else if (!strcmp(command, "clear_calibration")) {
    calibration = Calibration{};
    preferences.begin("turbidimeter", false);
    preferences.clear();
    preferences.end();
    saveBlank();  // Borrar la calibracion no debe perder la referencia optica.
    emitStatus("calibration_cleared");
    sendConfiguration();
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
      stateSumMv += analogReadMilliVolts(config.adcPin);
      if (++readCount >= config.readsPerState) {
        cycleOnMv = stateSumMv / readCount;
        saturated |= adcNearLimit(cycleOnMv);
        timingOverrun |= elapsedUs(micros(), phaseEndUs);
        state = AcquisitionState::HoldOn;
      }
      break;
    }
    case AcquisitionState::HoldOn:
      if (elapsedUs(nowUs, phaseEndUs)) {
        digitalWrite(config.ledPin, LOW);  // Inicio de la fase OFF del chopping.
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
      stateSumMv += analogReadMilliVolts(config.adcPin);
      if (++readCount >= config.readsPerState) {
        const double offMv = stateSumMv / readCount;
        saturated |= adcNearLimit(offMv);
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
