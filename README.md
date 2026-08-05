# Turbidímetro ESP32

El proyecto adquiere de forma síncrona la salida de un fotodetector (LTR-3208E con carga resistiva de 10 kΩ, u OPT101) con el LED infrarrojo encendido y apagado. El firmware transmite una línea JSON por resultado y el dashboard se conecta por Web Serial.

> **Guía de estudio completa**: [`docs/guia-turbidimetro.tex`](docs/guia-turbidimetro.tex) (122 páginas). Cubre la física de la dispersión, el diseño y los cálculos del circuito, el método de medida, la calibración y el análisis de los datos de `data/`. Se compila con `latexmk -pdf docs/guia-turbidimetro.tex`.

Soporta las dos geometrías de medición de turbidez, seleccionables desde el dashboard, porque cada una es válida en un rango distinto.

## Modos de medición

ISO 7027-1 separa los métodos por rango, no por preferencia: nefelométrico (90°) por debajo de 40 FNU, y atenuación de flujo radiante (180°) por encima de 40 FAU. El firmware implementa los dos y calcula la variable óptica que corresponde a cada uno.

| | **180° · Atenuación** | **90° · Nefelométrico** |
|---|---|---|
| El blanco de agua es | la referencia de 100 % de transmisión | el offset de luz parásita |
| y se usa | **dividiendo** | **restando** |
| Variable óptica | `T = ΔV / ΔV_agua`, `A = −log₁₀(T)` | `S = ΔV − ΔV_agua` |
| Al subir la turbidez | la señal baja | la señal sube |
| Rango lineal | hasta `A ≈ 1,5` (`T ≈ 3 %`) | concentraciones bajas |

Por eso el modo no es una etiqueta: cambia la expresión y el papel del blanco. A 90° no se muestran `T` ni `A`, porque darían transmitancia mayor que 1 y absorbancia negativa, que no tienen sentido físico.

El término correcto para `A` en una muestra turbia es **atenuancia**, no absorbancia: la extinción se debe a dispersión, no a absorción.

## Unidades

La escala se reporta en **mL/L de leche**, trazable a las diluciones volumétricas con las que se prepara la serie. No se reporta NTU ni FAU: ambas son unidades referidas a un patrón de formazina, que no se usó. La curva es convertible a esas unidades si se dispone del patrón.

`T` y `A` no necesitan ningún patrón, solo el blanco de agua.

## Conexiones predeterminadas

- Control del 2N3904: GPIO 25 (configurable).
- Nodo colector del LTR-3208E, a través de 1 kΩ: GPIO 34 / ADC1_CH6 (configurable entre GPIO 32, 33, 34, 35, 36 y 39).
- Puerto serie: 115200 baud.

El fototransistor tiene el colector elevado a 3,3 V mediante 10 kΩ y el emisor a GND. Al aumentar la luz dispersada, baja `V_ON`; por eso la definición predeterminada es `ΔV = V_OFF - V_ON`. El firmware permite volver a `V_ON - V_OFF` desde el dashboard si se instala el OPT101. El ADC usa 12 bits, atenuación de 11 dB y `analogReadMilliVolts()`.

Las tierras del emisor y del receptor se llevan a pines GND distintos del ESP32. Los dos pines son el mismo nodo eléctrico (no hay aislamiento galvánico), pero separar los **caminos de retorno** evita que los ~14 mA pulsados del LED circulen por el mismo cobre que el retorno del fotodetector: es una **tierra en estrella**, y elimina el **acoplamiento por impedancia común**.

> Si se alimenta el OPT101 a 5 V, su salida puede superar los 3,3 V y dañar la entrada del ADC. Aliméntelo a 3,3 V o intercale un divisor.

## Temporización

La configuración predeterminada es un semiperiodo de 1250 µs con 100 ciclos por resultado. El ciclo completo dura 2,5 ms, de modo que 100 ciclos son **250 ms, exactamente 15 periodos de red de 60 Hz**.

Integrar un número entero de periodos de red promedia a cero la interferencia de 60 Hz y todos sus armónicos, incluido el parpadeo de la iluminación fluorescente y LED, que ocurre a **120 Hz** (la intensidad sigue el valor absoluto de la onda, con dos picos por ciclo de red). El chopping por sí solo cancela la luz ambiente constante, pero no la que cambia entre la fase ON y la OFF; el promediado a periodo entero es lo que elimina ese residuo.

Con 2 lecturas por estado son 400 conversiones por resultado. Si las conversiones no caben en la fase, el resultado activa `timing_overrun`; debe reducirse el número de lecturas o ampliarse el semiperiodo. El tiempo de estabilización debe verificarse con osciloscopio.

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

1. Seleccione el modo (180° o 90°).
2. Configure la **dosificación** (ver abajo).
3. Con agua limpia, pulse **Medir blanco (agua)**. El ESP32 guarda la referencia en NVS, así que sobrevive a una recarga de la página. Se añade automáticamente el punto de dosis 0, que es el origen legítimo de la curva en ambos modos.
4. Añada cada dosis y pulse **Registrar punto**, indicando el volumen o la masa **acumulados** añadidos. También se pueden teclear los pares a mano.
5. Elija el modelo y pulse **Ajustar y enviar calibración**.

### Dosificación

Se teclea lo que realmente se dosifica y el dashboard calcula la concentración. La conversión no es cosmética: al añadir dosis el volumen total crece, y usar la dosis cruda como eje x metería una curvatura sistemática que después se confundiría con no linealidad de Beer-Lambert.

| Modo | Se teclea | Conversión | Unidad |
|---|---|---|---|
| Volumétrica (madre) | mL de solución madre | `C = C_madre · V / (V_base + V)` | mL/L |
| Gravimétrica | g de sólido | `C = 1000 · m / V_base` | g/L |
| Directa | la concentración ya calculada | ninguna | configurable |

Ejemplo: una madre de 10 mL de leche en 100 mL tiene `C_madre = 100 mL/L`. Añadiendo 1 mL de esa madre a 100 mL de agua, `C = 100 · 1 / 101 = 0,990 mL/L`, no 1. Al llegar a 10 mL el error de ignorar la corrección es del 9 %.

El modo gravimétrico desprecia el volumen desplazado por el sólido. Para polvos como la maicena conviene pesar en vez de medir volumen: la densidad aparente de un polvo varía con la compactación, mientras que la balanza es trazable.

La unidad se propaga a las etiquetas, los ejes de las gráficas y las estadísticas del ajuste. Los parámetros de dosificación se guardan en `localStorage`.

El ajuste es **respuesta = f(concentración)**, la dirección estándar de una curva de calibración, con el error en la respuesta. Esa dirección importa: la relación lineal por Beer-Lambert es `A` frente a la concentración, no `ΔV` frente a la concentración.

El dashboard reporta:

- **Sensibilidad**: pendiente de la respuesta frente a la concentración. En el modelo cuadrático se evalúa en el centro del rango.
- **R²**, sin ajustar. No sirve para elegir el modelo: siempre premia al polinomio de mayor grado.
- **s_y/x**: error estándar del ajuste con **n−p** grados de libertad, no n. Con pocos puntos la diferencia es grande, y es el valor que exige el cálculo del límite de detección.
- **LOD = 3·s_y/x / m** y **LOQ = 10·s_y/x / m**.
- **Rango calibrado**.
- **Residuos**: observado − predicho, frente a la concentración. Es la herramienta correcta para elegir entre lineal y cuadrático. Si se dispersan al azar alrededor de cero, el modelo es adecuado; una forma de U indica que la relación no es lineal; un abanico que se abre indica varianza creciente con la señal.

Para enviar la calibración al ESP32 se invierte la curva a `C = f⁻¹(respuesta)`: el modelo lineal se invierte de forma exacta, y el resto se remuestrea como curva por tramos (máximo 12 puntos), porque el firmware no resuelve inversiones analíticas. Si el ajuste no es monótono en el rango, la inversión sería ambigua y el dashboard lo rechaza.

**Borrar calibración** elimina del ESP32 la conversión de respuesta a concentración; **conserva** la referencia óptica de agua.

## Avisos automáticos

- `A > 1,5`: fuera del rango lineal de Beer-Lambert por luz parásita, hay que diluir la muestra.
- Señal dispersada por debajo de 3σ: no distinguible del blanco (criterio de límite de detección).
- ADC cerca de sus límites, desbordamiento de temporización y extrapolación fuera del rango calibrado.

## Protocolo Serial

Los comandos también son líneas JSON. Ejemplos:

```json
{"cmd":"start"}
{"cmd":"stop"}
{"cmd":"get_config"}
{"cmd":"set_config","led_pin":25,"adc_pin":34,"settle_us":100,"half_period_us":1250,"reads_per_state":2,"cycles_per_result":100,"result_interval_ms":500,"off_minus_on":true,"save_calibration":true,"mode":"attenuation"}
{"cmd":"set_blank","blank_mv":1234.5}
{"cmd":"set_blank","clear":true}
{"cmd":"set_calibration","model":"linear","a":0.1613,"b":0.0,"c":0.0,"valid_min":0.0,"valid_max":1.3}
{"cmd":"clear_calibration"}
```

`mode` acepta `attenuation` o `nephelometric`. En `set_calibration` los coeficientes mapean la variable óptica a concentración, y `points` usa las claves `x` (respuesta) e `y` (concentración).

Además de las mediciones, el equipo emite objetos `status` y `config`. Cada medición incluye `mode`, `blank_mv`, la variable óptica del modo activo (`transmittance_rel` y `attenuance`, o `net_scatter_mv`) y `concentration`. La desviación estándar, mínimo y máximo corresponden a los valores ΔV de los M ciclos; `adc_samples` cuenta todas las conversiones ON y OFF.
