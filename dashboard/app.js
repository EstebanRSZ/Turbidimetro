const $ = id => document.getElementById(id);
const history = [];
let port, reader, writer, keepReading = false, latest = null, fitResult = null, deviceConfig = null;

// El firmware interpola como máximo 12 puntos (MAX_PIECEWISE_POINTS en main.cpp).
const MAX_DEVICE_POINTS = 12;
// Por encima de A ≈ 1,5 (T < 3 %) la luz parásita domina y Beer-Lambert deja de
// ser lineal; el aviso marca el final del rango útil a 180°.
const MAX_LINEAR_ATTENUANCE = 1.5;
const DOSING_KEYS = ['dosingMode','baseVolume','stockConcentration','concentrationUnit'];

// Cada modo define su propia variable óptica, su blanco y sus etiquetas.
// Es la única tabla que hay que tocar para razonar sobre las dos geometrías.
const MODES = {
  attenuation: {
    label: '180° · Atenuación',
    field: 'attenuance',
    responseName: 'Atenuancia A',
    responseUnit: '',
    blankRole: 'referencia 100 % T',
    note: 'Modo 180°: el blanco de agua es la referencia de 100 % de transmisión y se <strong>divide</strong>. T = ΔV / ΔV<sub>agua</sub> y A = −log₁₀(T). La relación lineal por Beer-Lambert es A frente a la concentración, no ΔV frente a la concentración.',
    chartTitle: 'Atenuancia A frente al tiempo'
  },
  nephelometric: {
    label: '90° · Nefelométrico',
    field: 'net_scatter_mv',
    responseName: 'Señal neta S',
    responseUnit: 'mV',
    blankRole: 'offset de luz parásita',
    note: 'Modo 90°: el blanco de agua es el offset de luz parásita del frasco y del agua, y se <strong>resta</strong>. S = ΔV − ΔV<sub>agua</sub>. Aquí la señal crece con la turbidez, así que T y A no aplican: darían transmitancia mayor que 1 y absorbancia negativa.',
    chartTitle: 'Señal dispersada neta frente al tiempo'
  }
};
const currentMode = () => MODES[$('mode').value] || MODES.attenuation;

const chartOptions = {responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{ticks:{color:'#8fa7b1',maxTicksLimit:8},grid:{color:'#1c303b'},title:{display:false,text:'',color:'#8fa7b1'}},y:{ticks:{color:'#8fa7b1'},grid:{color:'#1c303b'},title:{display:false,text:'',color:'#8fa7b1'}}},plugins:{legend:{labels:{color:'#cce0e5'}}}};
function lineChart(id, datasets, linearX=false){
  const scales=JSON.parse(JSON.stringify(chartOptions.scales));
  if(linearX)scales.x.type='linear';
  return new Chart($(id),{type:'line',data:{labels:[],datasets},options:{...chartOptions,parsing:linearX?false:undefined,scales}});
}
function setAxisTitles(chart,xText,yText){
  Object.assign(chart.options.scales.x.title,{display:!!xText,text:xText||''});
  Object.assign(chart.options.scales.y.title,{display:!!yText,text:yText||''});
  chart.update('none');
}
const charts = {};

window.addEventListener('DOMContentLoaded',()=>{
  charts.delta=lineChart('deltaChart',[{label:'ΔV (mV)',data:[],borderColor:'#2dd4bf',pointRadius:0}]);
  charts.response=lineChart('responseChart',[{label:'Respuesta',data:[],borderColor:'#38bdf8',pointRadius:0}]);
  charts.voltage=lineChart('voltageChart',[{label:'V ON (mV)',data:[],borderColor:'#fbbf24',pointRadius:0},{label:'V OFF (mV)',data:[],borderColor:'#a78bfa',pointRadius:0}]);
  charts.calibration=lineChart('calibrationChart',[{label:'Puntos medidos',data:[],borderColor:'#38bdf8',backgroundColor:'#38bdf8',showLine:false,pointRadius:5},{label:'Ajuste',data:[],borderColor:'#2dd4bf',pointRadius:0}],true);
  charts.residual=lineChart('residualChart',[{label:'Residuo',data:[],borderColor:'#fb7185',backgroundColor:'#fb7185',showLine:false,pointRadius:5}],true);
  setAxisTitles(charts.delta,'Tiempo (s)','ΔV (mV)');
  setAxisTitles(charts.voltage,'Tiempo (s)','mV');
  bindEvents(); restoreDosing(); addPointRow(); addPointRow(); applyMode();
});

function bindEvents(){
  $('connect').onclick=connectSerial; $('start').onclick=()=>send({cmd:'start'}); $('stop').onclick=()=>send({cmd:'stop'});
  $('saveConfig').onclick=saveConfig; $('addPoint').onclick=()=>addPointRow(); $('fit').onclick=fitAndSend;
  $('blank').onclick=measureBlank; $('point').onclick=registerPoint; $('export').onclick=exportCsv;
  $('clearCalibration').onclick=clearCalibration; $('mode').onchange=changeMode;
  $('dosingMode').onchange=()=>{setDefaultUnit();applyDosing();};
  for(const id of ['baseVolume','stockConcentration','concentrationUnit'])$(id).oninput=applyDosing;
  $('clear').onclick=()=>{history.length=0; updateTimeCharts(); $('count').textContent='0'; setStatus('Historial borrado.');};
}

// --- Dosificación: dosis añadida -> concentración ---------------------------

const dosingParams = () => ({
  mode: $('dosingMode').value,
  baseVolume: parseFloat($('baseVolume').value),
  stockConcentration: parseFloat($('stockConcentration').value)
});
const concentrationUnit = () => $('concentrationUnit').value.trim() || 'u';

// Convierte lo que realmente se dosifica en la concentración de la muestra.
// La corrección importa: al añadir dosis el volumen total crece, y usar la
// dosis cruda como eje x metería una curvatura sistemática que después se
// confundiría con no linealidad de Beer-Lambert.
function concentrationFrom(dose){
  const p=dosingParams();
  if(!Number.isFinite(dose))return null;
  if(p.mode==='direct')return dose;
  if(!Number.isFinite(p.baseVolume)||p.baseVolume<=0)return null;
  // Gravimétrica: el polvo desplaza un volumen despreciable frente al agua base.
  if(p.mode==='mass')return 1000*dose/p.baseVolume;
  if(!Number.isFinite(p.stockConcentration))return null;
  const total=p.baseVolume+dose;
  return total>0?p.stockConcentration*dose/total:null;
}

function setDefaultUnit(){
  const mode=$('dosingMode').value;
  if(mode==='stock')$('concentrationUnit').value='mL/L';
  else if(mode==='mass')$('concentrationUnit').value='g/L';
}

function applyDosing(){
  const p=dosingParams(),unit=concentrationUnit();
  $('stockField').classList.toggle('hidden',p.mode!=='stock');
  $('pointsTable').classList.toggle('no-conversion',p.mode==='direct');
  $('doseHeader').textContent=p.mode==='stock'?'Madre añadida (mL)':p.mode==='mass'?`Masa añadida (g)`:`C (${unit})`;
  $('concentrationHeader').textContent=`C (${unit})`;
  $('concentrationUnitLabel').textContent=unit;
  // La fórmula se imprime con los números reales para poder verificarla a mano.
  const base=Number.isFinite(p.baseVolume)?p.baseVolume:'V_base';
  $('dosingFormula').innerHTML=
    p.mode==='stock'?`C = C<sub>madre</sub> · V / (V<sub>base</sub> + V) = ${p.stockConcentration||'C_madre'} · V / (${base} + V). Con una madre de 10 mL de leche en 100 mL, C<sub>madre</sub> = 100 mL/L.`:
    p.mode==='mass'?`C = 1000 · m / V<sub>base</sub> = 1000 · m / ${base}. Se desprecia el volumen desplazado por el sólido.`:
    'Se usa el valor tecleado tal cual, sin conversión.';
  for(const id of DOSING_KEYS)localStorage.setItem(`turb.${id}`,$(id).value);
  refreshRows(); applyMode();
}

function restoreDosing(){
  for(const id of DOSING_KEYS){const saved=localStorage.getItem(`turb.${id}`);if(saved!==null)$(id).value=saved;}
  applyDosing();
}

const fmtConcentration = c => c==null||!Number.isFinite(c)?'—':(Math.abs(c)>=1?c.toFixed(3):c.toPrecision(3));
function refreshRows(){for(const row of $('points').rows)refreshRow(row);}
function refreshRow(row){
  const dose=parseFloat(row.cells[0].querySelector('input').value);
  row.cells[1].textContent=fmtConcentration(concentrationFrom(dose));
}

// --- Modo de medición -------------------------------------------------------

function applyMode(){
  const mode=currentMode(),unit=concentrationUnit();
  for(const article of document.querySelectorAll('.metrics article[data-mode]'))
    article.classList.toggle('hidden', article.dataset.mode!==$('mode').value);
  $('modeNote').innerHTML=mode.note;
  $('blankRole').textContent=mode.blankRole;
  $('responseHeader').textContent=mode.responseName;
  $('responseChartTitle').textContent=mode.chartTitle;
  charts.response.data.datasets[0].label=mode.responseName;
  const responseAxis=mode.responseUnit?`${mode.responseName} (${mode.responseUnit})`:mode.responseName;
  setAxisTitles(charts.response,'Tiempo (s)',responseAxis);
  setAxisTitles(charts.calibration,`Concentración (${unit})`,responseAxis);
  setAxisTitles(charts.residual,`Concentración (${unit})`,`Residuo${mode.responseUnit?` (${mode.responseUnit})`:''}`);
  updateTimeCharts();
}

function changeMode(){
  applyMode();
  // La calibración anterior se ajustó en la variable óptica del otro modo, así
  // que sus coeficientes ya no significan nada aquí.
  invalidateFit();
  send({cmd:'set_config', mode:$('mode').value});
  setStatus(`Modo ${currentMode().label}. La calibración anterior ya no aplica: vuelve a medir el blanco y a ajustar.`);
}

function invalidateFit(){
  fitResult=null; $('fitStats').textContent='Aún no hay ajuste.';
  for(const chart of [charts.calibration,charts.residual]){chart.data.datasets.forEach(d=>d.data=[]);chart.update();}
}

// --- Puerto serie -----------------------------------------------------------

async function connectSerial(){
  if(!('serial' in navigator)){setStatus('Web Serial requiere Chrome o Edge en HTTPS/localhost.');return;}
  try{
    port=await navigator.serial.requestPort(); await port.open({baudRate:115200});
    writer=port.writable.getWriter(); keepReading=true; $('connection').textContent='Conectado'; $('connection').className='badge online';
    $('connect').textContent='Puerto conectado'; readLoop(); await send({cmd:'get_config'});
  }catch(error){setStatus(`No se pudo conectar: ${error.message}`);}
}

async function readLoop(){
  const decoder=new TextDecoderStream(); const closed=port.readable.pipeTo(decoder.writable); reader=decoder.readable.getReader(); let buffer='';
  try{while(keepReading){const {value,done}=await reader.read();if(done)break;buffer+=value;let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(line)handleLine(line);}}}
  catch(error){setStatus(`Lectura detenida: ${error.message}`);}finally{reader.releaseLock();await closed.catch(()=>{});}
}

async function send(object){if(!writer){setStatus('Conecta primero el ESP32.');return;}await writer.write(new TextEncoder().encode(JSON.stringify(object)+'\n'));}

function handleLine(line){
  try{
    const data=JSON.parse(line);
    if(data.type==='measurement')addMeasurement(data);
    else if(data.type==='config')loadConfig(data);
    else if(data.type==='status'&&data.event==='calibration_cleared')finishCalibrationClear();
    else if(data.type==='status')setStatus(data.message||data.event);
  }catch{setStatus(`Línea no JSON ignorada: ${line.slice(0,80)}`);}
}

// --- Mediciones -------------------------------------------------------------

// La respuesta es la variable óptica que calcula el firmware, no un número que
// recalcule el dashboard: así device y dashboard nunca pueden divergir.
const responseOf = data => data==null?null:numberOrNull(data[currentMode().field]);
const numberOrNull = value => value==null||!Number.isFinite(Number(value))?null:Number(value);

function addMeasurement(data){
  latest=data;
  history.push({...data,received_at:new Date().toISOString()});
  if(history.length>1000)history.shift();
  $('vOn').textContent=fmt(data.v_on_mv);$('vOff').textContent=fmt(data.v_off_mv);$('delta').textContent=fmt(data.delta_mv);
  $('transmittance').textContent=data.transmittance_rel==null?'Sin blanco':fmt(data.transmittance_rel,4);
  $('attenuance').textContent=data.attenuance==null?'Sin blanco':fmt(data.attenuance,4);
  $('netScatter').textContent=data.net_scatter_mv==null?'Sin blanco':fmt(data.net_scatter_mv);
  $('blankReference').textContent=fmt(data.blank_mv);
  $('concentration').textContent=data.concentration==null?'Sin calibrar':fmt(data.concentration);
  $('stddev').textContent=fmt(data.stddev_mv);$('snr').textContent=fmt(data.snr);
  $('saturation').textContent=data.saturated?'Saturado':'Normal';$('saturation').style.color=data.saturated?'#fb7185':'#5eead4';
  $('count').textContent=data.sequence;
  updateWarnings(data);updateTimeCharts();
}

function updateWarnings(data){
  const warning=[];
  if(data?.saturated)warning.push('ADC cerca de uno de sus límites.');
  if(data?.timing_overrun)warning.push('Las lecturas no caben en la fase ON/OFF; reduzca N o aumente el semiperiodo.');
  if(data?.extrapolated)warning.push('Resultado fuera del rango calibrado: extrapolación.');
  const attenuance=numberOrNull(data?.attenuance);
  if(attenuance!=null&&attenuance>MAX_LINEAR_ATTENUANCE)
    warning.push(`A = ${attenuance.toFixed(2)} supera ${MAX_LINEAR_ATTENUANCE}: fuera del rango lineal de Beer-Lambert, diluya la muestra.`);
  // A 90° la señal útil compite con el ruido del propio ΔV: por debajo de 3σ no
  // es distinguible del blanco (criterio de límite de detección).
  const scatter=numberOrNull(data?.net_scatter_mv), sigma=numberOrNull(data?.stddev_mv);
  if(scatter!=null&&sigma!=null&&sigma>0&&Math.abs(scatter)<3*sigma)
    warning.push(`Señal dispersada (${scatter.toFixed(2)} mV) por debajo de 3σ (${(3*sigma).toFixed(2)} mV): no distinguible del blanco.`);
  $('warning').textContent=warning.join(' ');$('warning').classList.toggle('hidden',!warning.length);
}

function fmt(value,decimals=3){return value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(decimals)}

function updateTimeCharts(){
  const view=history.slice(-120), labels=view.map(v=>(v.uptime_ms/1000).toFixed(1));
  setChart(charts.delta,labels,[view.map(v=>v.delta_mv)]);
  setChart(charts.response,labels,[view.map(responseOf)]);
  setChart(charts.voltage,labels,[view.map(v=>v.v_on_mv),view.map(v=>v.v_off_mv)]);
}
function setChart(chart,labels,series){chart.data.labels=labels;series.forEach((s,i)=>chart.data.datasets[i].data=s);chart.update('none');}

function loadConfig(c){
  deviceConfig=c;
  $('ledPin').value=c.led_pin;$('adcPin').value=c.adc_pin;$('settleUs').value=c.settle_us;$('halfPeriodUs').value=c.half_period_us;
  $('reads').value=c.reads_per_state;$('cycles').value=c.cycles_per_result;$('interval').value=c.result_interval_ms;
  $('deltaMode').value=c.off_minus_on?'off-on':'on-off';$('saveNvs').checked=c.save_calibration;
  $('blankReference').textContent=fmt(c.blank_mv);
  // El ESP32 conserva modo y blanco en NVS, así que recargar la página ya no
  // obliga a repetir la referencia de agua.
  if(c.mode&&c.mode!==$('mode').value){$('mode').value=c.mode;applyMode();}
}

function saveConfig(){
  send({cmd:'set_config',led_pin:+$('ledPin').value,adc_pin:+$('adcPin').value,settle_us:+$('settleUs').value,
        half_period_us:+$('halfPeriodUs').value,reads_per_state:+$('reads').value,cycles_per_result:+$('cycles').value,
        result_interval_ms:+$('interval').value,off_minus_on:$('deltaMode').value==='off-on',
        save_calibration:$('saveNvs').checked,mode:$('mode').value});
}

// --- Tabla de calibración ---------------------------------------------------

function addPointRow(dose='',response=''){
  const row=document.createElement('tr');
  row.innerHTML=`<td><input type="number" step="any" value="${dose}" aria-label="Dosis añadida"></td>`+
                `<td class="col-c computed">—</td>`+
                `<td><input type="number" step="any" value="${response}" aria-label="Respuesta"></td>`+
                `<td><button class="danger" aria-label="Eliminar">×</button></td>`;
  row.querySelector('button').onclick=()=>row.remove();
  row.cells[0].querySelector('input').oninput=()=>refreshRow(row);
  $('points').appendChild(row);refreshRow(row);
}

function readPoints(){
  return [...$('points').rows].map(r=>{
    const dose=r.cells[0].querySelector('input').value.trim(), y=r.cells[2].querySelector('input').value.trim();
    if(dose===''||y==='')return null;
    const c=concentrationFrom(+dose);
    return c==null||!Number.isFinite(c)||!Number.isFinite(+y)?null:{c,y:+y,dose:+dose};
  }).filter(Boolean);
}

function measureBlank(){
  if(!latest){setStatus('Aún no hay una medición para registrar como blanco.');return;}
  const signal=Number(latest.delta_mv);
  if(!(signal>0)){setStatus('El blanco debe tener un ΔV positivo.');return;}
  send({cmd:'set_blank',blank_mv:signal});
  // Con agua limpia la respuesta vale cero en ambos modos: A = −log₁₀(1) = 0 y
  // S = ΔV − ΔV_agua = 0. Es el origen legítimo de la curva de calibración.
  addPointRow(0,0);
  setStatus(`Blanco fijado en ${signal.toFixed(3)} mV y añadido como punto de dosis 0.`);
}

function registerPoint(){
  if(!latest){setStatus('Aún no hay una medición.');return;}
  const response=responseOf(latest);
  if(response==null){setStatus('Sin blanco todavía: mide primero el blanco de agua.');return;}
  const prompts={stock:'Madre acumulada añadida (mL):',mass:'Masa acumulada añadida (g):',direct:`Concentración (${concentrationUnit()}):`};
  const value=prompt(prompts[dosingParams().mode]);
  if(value===null||value.trim()===''||!Number.isFinite(+value))return;
  addPointRow(+value,response);
  const c=concentrationFrom(+value);
  setStatus(`Punto registrado: ${fmtConcentration(c)} ${concentrationUnit()} con ${currentMode().responseName} = ${response.toFixed(4)}.`);
}

async function clearCalibration(){
  if(!writer){setStatus('Conecta primero el ESP32.');return;}
  setStatus('Borrando calibración del ESP32…');
  try{await send({cmd:'clear_calibration'});}catch(error){setStatus(`No se pudo enviar el borrado: ${error.message}`);}
}

function finishCalibrationClear(){
  invalidateFit();
  $('points').replaceChildren();addPointRow();addPointRow();
  $('concentration').textContent='Sin calibrar';
  setStatus('Calibración borrada del ESP32. La referencia de agua se conserva.');
}

// --- Ajuste por mínimos cuadrados -------------------------------------------

function solve(matrix, vector){
  const n=vector.length,a=matrix.map((r,i)=>[...r,vector[i]]);for(let i=0;i<n;i++){let p=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;[a[i],a[p]]=[a[p],a[i]];if(Math.abs(a[i][i])<1e-12)throw Error('Puntos insuficientes o degenerados.');for(let j=i+1;j<n;j++){const f=a[j][i]/a[i][i];for(let k=i;k<=n;k++)a[j][k]-=f*a[i][k];}}
  const x=Array(n);for(let i=n-1;i>=0;i--){x[i]=(a[i][n]-a[i].slice(i+1,n).reduce((s,v,j)=>s+v*x[i+1+j],0))/a[i][i];}return x;
}

// Ajusta respuesta = f(concentración): la dirección estándar de una curva de
// calibración, con el error en la respuesta. La pendiente es la sensibilidad.
function polynomialFit(points,degree){
  const size=degree+1,m=Array.from({length:size},()=>Array(size).fill(0)),v=Array(size).fill(0);
  for(const p of points)for(let r=0;r<size;r++){v[r]+=p.y*p.c**r;for(let col=0;col<size;col++)m[r][col]+=p.c**(r+col);}
  return solve(m,v);
}

function predictResponse(fit,c){
  if(fit.model==='piecewise'){
    const sorted=[...fit.points].sort((a,b)=>a.c-b.c);
    let i=1;while(i<sorted.length&&c>sorted[i].c)i++;i=Math.min(i,sorted.length-1);
    const l=sorted[i-1],u=sorted[i];
    return l.y+(c-l.c)*(u.y-l.y)/(u.c-l.c);
  }
  return fit.coeffs.reduce((sum,k,i)=>sum+k*c**i,0);
}

function fitAndSend(){
  const points=readPoints(),model=$('model').value,minCount=model==='quadratic'?3:2;
  if(points.length<minCount){setStatus(`El modelo requiere al menos ${minCount} puntos.`);return;}
  if(new Set(points.map(p=>p.c)).size!==points.length){setStatus('Las concentraciones deben ser distintas.');return;}
  try{
    const degree=model==='quadratic'?2:1;
    const coeffs=model==='piecewise'?[]:polynomialFit(points,degree);
    const fit={model,coeffs,points};
    const estimates=points.map(p=>predictResponse(fit,p.c));
    const residuals=points.map((p,i)=>p.y-estimates[i]);

    const mean=points.reduce((s,p)=>s+p.y,0)/points.length;
    const sse=residuals.reduce((s,r)=>s+r*r,0);
    const sst=points.reduce((s,p)=>s+(p.y-mean)**2,0);
    const r2=sst?1-sse/sst:1;
    // Error estándar del ajuste con n−p grados de libertad (no n): es el valor
    // que exige el cálculo de LOD, y con pocos puntos la diferencia es grande.
    const dof=points.length-(model==='piecewise'?points.length:degree+1);
    const syx=dof>0?Math.sqrt(sse/dof):NaN;

    const cMin=Math.min(...points.map(p=>p.c)),cMax=Math.max(...points.map(p=>p.c));
    const sensitivity=sensitivityOf(fit,cMin,cMax);
    const lod=Number.isFinite(syx)&&Math.abs(sensitivity)>0?3*syx/Math.abs(sensitivity):NaN;
    const loq=Number.isFinite(lod)?lod*10/3:NaN;

    fitResult={...fit,r2,syx,sensitivity,lod,loq,cMin,cMax,residuals,dof};
    renderStats();renderCalibration();
    sendDeviceCalibration();
  }catch(error){setStatus(error.message);}
}

// Sensibilidad = pendiente de la respuesta frente a la concentración. En el
// modelo cuadrático varía, así que se evalúa en el centro del rango.
function sensitivityOf(fit,cMin,cMax){
  if(fit.model==='linear')return fit.coeffs[1];
  if(fit.model==='quadratic'){const mid=(cMin+cMax)/2;return fit.coeffs[1]+2*fit.coeffs[2]*mid;}
  return (predictResponse(fit,cMax)-predictResponse(fit,cMin))/(cMax-cMin||1);
}

function renderStats(){
  const f=fitResult,unit=concentrationUnit();
  const rUnit=currentMode().responseUnit?` ${currentMode().responseUnit}`:'';
  const rows=[
    `Sensibilidad: <strong>${f.sensitivity.toPrecision(4)}${rUnit} por ${unit}</strong>`,
    `R²: <strong>${f.r2.toFixed(6)}</strong>`,
    Number.isFinite(f.syx)?`s<sub>y/x</sub>: <strong>${f.syx.toPrecision(4)}${rUnit}</strong> (n−p = ${f.dof})`:'s<sub>y/x</sub>: — (sin grados de libertad)',
    Number.isFinite(f.lod)?`LOD (3s<sub>y/x</sub>/m): <strong>${f.lod.toPrecision(3)} ${unit}</strong> · LOQ (10s<sub>y/x</sub>/m): <strong>${f.loq.toPrecision(3)} ${unit}</strong>`:'LOD/LOQ: —',
    `Rango calibrado: ${fmtConcentration(f.cMin)} a ${fmtConcentration(f.cMax)} ${unit}`
  ];
  $('fitStats').innerHTML=rows.join('<br>')+
    '<br><small>Compare modelos con la gráfica de residuos, no con R²: el R² sin ajustar siempre premia al polinomio de mayor grado.</small>';
}

function renderCalibration(){
  const f=fitResult,span=f.cMax-f.cMin||1;
  const line=Array.from({length:80},(_,i)=>{const c=f.cMin-span*.05+i*span*1.1/79;return{x:c,y:predictResponse(f,c)}});
  charts.calibration.data.datasets[0].data=f.points.map(p=>({x:p.c,y:p.y}));
  charts.calibration.data.datasets[1].data=line;charts.calibration.update();
  charts.residual.data.datasets[0].data=f.points.map((p,i)=>({x:p.c,y:f.residuals[i]}));charts.residual.update();
}

// El ajuste es respuesta = f(C), pero el instrumento necesita C = f⁻¹(respuesta).
// La lineal se invierte exactamente; el resto se envía como curva remuestreada
// porque el firmware no resuelve inversiones analíticas.
function sendDeviceCalibration(){
  const f=fitResult;
  const yMin=predictResponse(f,f.cMin),yMax=predictResponse(f,f.cMax);
  if(!(Math.abs(yMax-yMin)>1e-12)){setStatus('La respuesta no cambia en el rango: no se puede invertir.');return;}

  const samples=Array.from({length:MAX_DEVICE_POINTS},(_,i)=>{
    const c=f.cMin+(f.cMax-f.cMin)*i/(MAX_DEVICE_POINTS-1);
    return {x:predictResponse(f,c),y:c};
  });
  const increasing=yMax>yMin;
  const monotonic=samples.every((s,i)=>i===0||(increasing?s.x>samples[i-1].x:s.x<samples[i-1].x));
  if(!monotonic){setStatus('El ajuste no es monótono en el rango: la inversión sería ambigua. Use el modelo lineal o recorte el rango.');return;}

  const command={cmd:'set_calibration',valid_min:Math.min(yMin,yMax),valid_max:Math.max(yMin,yMax)};
  if(f.model==='linear'&&Math.abs(f.coeffs[1])>1e-12){
    Object.assign(command,{model:'linear',a:1/f.coeffs[1],b:-f.coeffs[0]/f.coeffs[1],c:0});
  }else{
    Object.assign(command,{model:'piecewise',a:0,b:0,c:0,points:increasing?samples:[...samples].reverse()});
  }
  send(command);
}

// --- Exportación ------------------------------------------------------------

function exportCsv(){
  if(!history.length){setStatus('No hay datos para exportar.');return;}
  const fields=['received_at','sequence','uptime_ms','mode','v_on_mv','v_off_mv','delta_mv','blank_mv',
    'transmittance_rel','attenuance','net_scatter_mv','delta_definition','stddev_mv','min_mv','max_mv','snr',
    'cycles','adc_samples','saturated','timing_overrun','calibrated','calibration_type','concentration','extrapolated'];
  const rows=[fields.join(','),...history.map(r=>fields.map(f=>r[f]??'').join(','))];
  const blob=new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`turbidimetro-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;a.click();URL.revokeObjectURL(a.href);
}

function setStatus(message){$('status').textContent=message;}
