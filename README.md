# Turbidímetro por transmitancia ESP32

El proyecto adquiere de forma síncrona la salida de un LTR-3208E con carga resistiva de 10 kΩ y el LED infrarrojo encendido y apagado. El firmware transmite una línea JSON por resultado y el dashboard se conecta por Web Serial.

## Conexiones predeterminadas

- Control del 2N3904: GPIO 25 (configurable).
- Nodo colector del LTR-3208E, a través de 1 kΩ: GPIO 34 / ADC1_CH6 (configurable entre GPIO 32, 33, 34, 35, 36 y 39).
- Puerto serie: 115200 baud.

El fototransistor tiene el colector elevado a 3,3 V mediante 10 kΩ y el emisor a GND. Al aumentar la luz dispersada, baja `V_ON`; por eso la definición predeterminada es `ΔV = V_OFF - V_ON`. El firmware permite volver a `V_ON - V_OFF` desde el dashboard si se reinstala el OPT101. El ADC usa 12 bits, atenuación de 11 dB y `analogReadMilliVolts()`.

La temporización predeterminada es 2 kHz: fases ON y OFF de 250 µs, con 100 µs de estabilización y cuatro lecturas por estado. Si las conversiones no caben en la fase, el resultado activa `timing_overrun`; debe reducirse el número de lecturas o ampliarse el semiperiodo. El tiempo de estabilización debe verificarse con osciloscopio.

## Compilación y carga

Con PlatformIO instalado:

```powershell
pio run
pio run --target upload
pio device monitor --baud 115200
```

Si la placa no aparece en `COM7`, cambie o quite `upload_port` en `platformio.ini`.

## Dashboard

Sirva la carpeta `dashboard` desde localhost; Web Serial no funciona al abrir el HTML directamente en todos los navegadores:

```powershell
python -m http.server 8000 --directory dashboard
```

Abra `http://localhost:8000` en Chrome o Edge, pulse **Conectar puerto** y elija el ESP32. Chart.js se carga desde jsDelivr, por lo que el navegador necesita conexión a Internet al abrir el dashboard.

## Calibración

Registre pares reales `NTU referencia, ΔV medido`. El dashboard ajusta modelos lineal o cuadrático por mínimos cuadrados, o interpola por tramos; muestra R², RMSE, residuos y rango válido. Los coeficientes se envían al ESP32 y opcionalmente se guardan en NVS. Sin calibración, el firmware entrega `ntu: null` y nunca presenta ΔV como NTU.

Para la medición por transmisión a 180°, coloque agua limpia y pulse **Medir blanco**. El dashboard conserva ese `ΔV` como `S_agua` y calcula en las mediciones siguientes `Trel = S_muestra / S_agua`, `A = -ln(Trel)` y `A10 = -log10(Trel)`. La referencia dura hasta que se recarga la página. **Borrar calibración** elimina del ESP32 la conversión persistida de `ΔV` a NTU; no borra la referencia óptica de la sesión.

## Protocolo Serial

Los comandos también son líneas JSON. Ejemplos:

```json
{"cmd":"start"}
{"cmd":"stop"}
{"cmd":"get_config"}
{"cmd":"set_config","led_pin":25,"adc_pin":34,"settle_us":100,"half_period_us":250,"reads_per_state":4,"cycles_per_result":32,"result_interval_ms":500,"off_minus_on":true,"save_calibration":true}
```

Además de las mediciones, el equipo emite objetos `status` y `config`. La desviación estándar, mínimo y máximo corresponden a los valores ΔV de los M ciclos; `adc_samples` cuenta todas las conversiones ON y OFF.
