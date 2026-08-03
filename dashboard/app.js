const $ = id => document.getElementById(id);
const history = [];
const calibrationPoints = [];
let port, reader, writer, keepReading = false, latest = null, fitResult = null;

const chartOptions = {responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{ticks:{color:'#8fa7b1',maxTicksLimit:8},grid:{color:'#1c303b'}},y:{ticks:{color:'#8fa7b1'},grid:{color:'#1c303b'}}},plugins:{legend:{labels:{color:'#cce0e5'}}}};
function lineChart(id, datasets, linearX=false){return new Chart($(id),{type:'line',data:{labels:[],datasets},options:{...chartOptions,parsing:linearX?false:undefined,scales:linearX?{...chartOptions.scales,x:{...chartOptions.scales.x,type:'linear'}}:chartOptions.scales}})}
const charts = {};

window.addEventListener('DOMContentLoaded',()=>{
  charts.delta=lineChart('deltaChart',[{label:'ΔV (mV)',data:[],borderColor:'#2dd4bf',pointRadius:0}]);
  charts.ntu=lineChart('ntuChart',[{label:'NTU',data:[],borderColor:'#38bdf8',pointRadius:0}]);
  charts.voltage=lineChart('voltageChart',[{label:'V ON (mV)',data:[],borderColor:'#fbbf24',pointRadius:0},{label:'V OFF (mV)',data:[],borderColor:'#a78bfa',pointRadius:0}]);
  charts.calibration=lineChart('calibrationChart',[{label:'Patrones',data:[],borderColor:'#38bdf8',backgroundColor:'#38bdf8',showLine:false,pointRadius:5},{label:'Ajuste',data:[],borderColor:'#2dd4bf',pointRadius:0}],true);
  charts.residual=lineChart('residualChart',[{label:'Residuo (NTU)',data:[],borderColor:'#fb7185',backgroundColor:'#fb7185',showLine:false,pointRadius:5}],true);
  bindEvents(); addPointRow(); addPointRow();
});

function bindEvents(){
  $('connect').onclick=connectSerial; $('start').onclick=()=>send({cmd:'start'}); $('stop').onclick=()=>send({cmd:'stop'});
  $('saveConfig').onclick=saveConfig; $('addPoint').onclick=()=>addPointRow(); $('fit').onclick=fitAndSend;
  $('blank').onclick=measureBlank; $('pattern').onclick=registerPattern; $('export').onclick=exportCsv;
  $('clear').onclick=()=>{history.length=0; updateTimeCharts(); $('count').textContent='0'; setStatus('Historial borrado.');};
}

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
function handleLine(line){try{const data=JSON.parse(line);if(data.type==='measurement')addMeasurement(data);else if(data.type==='config')loadConfig(data);else if(data.type==='status')setStatus(data.message||data.event);}catch{setStatus(`Línea no JSON ignorada: ${line.slice(0,80)}`);}}

function addMeasurement(data){
  latest=data; history.push({...data,received_at:new Date().toISOString()}); if(history.length>1000)history.shift();
  $('vOn').textContent=fmt(data.v_on_mv);$('vOff').textContent=fmt(data.v_off_mv);$('delta').textContent=fmt(data.delta_mv);
  $('ntu').textContent=data.ntu==null?'Sin calibrar':fmt(data.ntu);$('stddev').textContent=fmt(data.stddev_mv);$('snr').textContent=fmt(data.snr);
  $('saturation').textContent=data.saturated?'Saturado':'Normal';$('saturation').style.color=data.saturated?'#fb7185':'#5eead4';$('count').textContent=data.sequence;
  const warning=[];if(data.saturated)warning.push('ADC cerca de uno de sus límites.');if(data.timing_overrun)warning.push('Las lecturas no caben en la fase ON/OFF; reduzca N o aumente el semiperiodo.');if(data.extrapolated)warning.push('Resultado fuera del rango calibrado: extrapolación.');
  $('warning').textContent=warning.join(' ');$('warning').classList.toggle('hidden',!warning.length);updateTimeCharts();
}
function fmt(value){return value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(3)}
function updateTimeCharts(){const view=history.slice(-120), labels=view.map(v=>(v.uptime_ms/1000).toFixed(1));setChart(charts.delta,labels,[view.map(v=>v.delta_mv)]);setChart(charts.ntu,labels,[view.map(v=>v.ntu)]);setChart(charts.voltage,labels,[view.map(v=>v.v_on_mv),view.map(v=>v.v_off_mv)]);}
function setChart(chart,labels,series){chart.data.labels=labels;series.forEach((s,i)=>chart.data.datasets[i].data=s);chart.update('none');}

function loadConfig(c){$('ledPin').value=c.led_pin;$('adcPin').value=c.adc_pin;$('settleUs').value=c.settle_us;$('halfPeriodUs').value=c.half_period_us;$('reads').value=c.reads_per_state;$('cycles').value=c.cycles_per_result;$('interval').value=c.result_interval_ms;$('deltaMode').value=c.off_minus_on?'off-on':'on-off';$('saveNvs').checked=c.save_calibration;}
function saveConfig(){send({cmd:'set_config',led_pin:+$('ledPin').value,adc_pin:+$('adcPin').value,settle_us:+$('settleUs').value,half_period_us:+$('halfPeriodUs').value,reads_per_state:+$('reads').value,cycles_per_result:+$('cycles').value,result_interval_ms:+$('interval').value,off_minus_on:$('deltaMode').value==='off-on',save_calibration:$('saveNvs').checked});}

function addPointRow(ntu='',delta=''){
  const row=document.createElement('tr');row.innerHTML=`<td><input type="number" step="any" value="${ntu}" aria-label="NTU referencia"></td><td><input type="number" step="any" value="${delta}" aria-label="Delta V"></td><td><button class="danger" aria-label="Eliminar">×</button></td>`;
  row.querySelector('button').onclick=()=>row.remove();$('points').appendChild(row);
}
function readPoints(){return [...$('points').rows].map(r=>({ntu:+r.cells[0].querySelector('input').value,delta:+r.cells[1].querySelector('input').value})).filter(p=>Number.isFinite(p.ntu)&&Number.isFinite(p.delta));}
function measureBlank(){if(!latest){setStatus('Aún no hay una medición para registrar como blanco.');return;}addPointRow(0,latest.delta_mv);setStatus('Blanco añadido como 0 NTU; confirma el valor de referencia antes de ajustar.');}
function registerPattern(){if(!latest){setStatus('Aún no hay una medición.');return;}const value=prompt('NTU certificado del patrón:');if(value!==null&&value.trim()!==''&&Number.isFinite(+value))addPointRow(+value,latest.delta_mv);}

function solve(matrix, vector){
  const n=vector.length,a=matrix.map((r,i)=>[...r,vector[i]]);for(let i=0;i<n;i++){let p=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;[a[i],a[p]]=[a[p],a[i]];if(Math.abs(a[i][i])<1e-12)throw Error('Puntos insuficientes o degenerados.');for(let j=i+1;j<n;j++){const f=a[j][i]/a[i][i];for(let k=i;k<=n;k++)a[j][k]-=f*a[i][k];}}
  const x=Array(n);for(let i=n-1;i>=0;i--){x[i]=(a[i][n]-a[i].slice(i+1,n).reduce((s,v,j)=>s+v*x[i+1+j],0))/a[i][i];}return x;
}
function polynomialFit(points,degree){
  const size=degree+1,m=Array.from({length:size},()=>Array(size).fill(0)),v=Array(size).fill(0);
  for(const p of points)for(let r=0;r<size;r++){v[r]+=p.ntu*p.delta**r;for(let c=0;c<size;c++)m[r][c]+=p.delta**(r+c);}return solve(m,v);
}
function predict(model,coeffs,points,x){if(model==='piecewise'){const sorted=[...points].sort((a,b)=>a.delta-b.delta);let i=1;while(i<sorted.length&&x>sorted[i].delta)i++;i=Math.min(i,sorted.length-1);const l=sorted[i-1],u=sorted[i];return l.ntu+(x-l.delta)*(u.ntu-l.ntu)/(u.delta-l.delta);}return coeffs.reduce((sum,c,i)=>sum+c*x**i,0);}
function fitAndSend(){
  const points=readPoints(),model=$('model').value,minCount=model==='quadratic'?3:2;if(points.length<minCount){setStatus(`El modelo requiere al menos ${minCount} puntos.`);return;}
  const unique=new Set(points.map(p=>p.delta));if(unique.size!==points.length){setStatus('Los valores ΔV deben ser distintos.');return;}
  try{
    const coeffs=model==='piecewise'?[]:polynomialFit(points,model==='quadratic'?2:1);const estimates=points.map(p=>predict(model,coeffs,points,p.delta));const residuals=points.map((p,i)=>p.ntu-estimates[i]);
    const mean=points.reduce((s,p)=>s+p.ntu,0)/points.length,sse=residuals.reduce((s,r)=>s+r*r,0),sst=points.reduce((s,p)=>s+(p.ntu-mean)**2,0),r2=sst?1-sse/sst:1,rmse=Math.sqrt(sse/points.length);
    const min=Math.min(...points.map(p=>p.delta)),max=Math.max(...points.map(p=>p.delta));fitResult={model,coeffs,points,r2,rmse,min,max,residuals};
    $('fitStats').innerHTML=`R²: <strong>${r2.toFixed(6)}</strong> · RMSE: <strong>${rmse.toFixed(4)} NTU</strong><br>Rango válido: ${min.toFixed(3)} a ${max.toFixed(3)} mV`;
    renderCalibration();const command={cmd:'set_calibration',model,valid_min_mv:min,valid_max_mv:max,a:0,b:0,c:0};
    if(model==='linear'){command.a=coeffs[1];command.b=coeffs[0];}else if(model==='quadratic'){command.a=coeffs[2];command.b=coeffs[1];command.c=coeffs[0];}else command.points=[...points].sort((a,b)=>a.delta-b.delta).map(p=>({delta_mv:p.delta,ntu:p.ntu}));send(command);
  }catch(error){setStatus(error.message);}
}
function renderCalibration(){const f=fitResult,span=f.max-f.min||1,line=Array.from({length:80},(_,i)=>{const x=f.min-span*.05+i*span*1.1/79;return{x,y:predict(f.model,f.coeffs,f.points,x)}});charts.calibration.data.datasets[0].data=f.points.map(p=>({x:p.delta,y:p.ntu}));charts.calibration.data.datasets[1].data=line;charts.calibration.update();charts.residual.data.datasets[0].data=f.points.map((p,i)=>({x:p.delta,y:f.residuals[i]}));charts.residual.update();}

function exportCsv(){if(!history.length){setStatus('No hay datos para exportar.');return;}const fields=['received_at','sequence','uptime_ms','v_on_mv','v_off_mv','delta_mv','delta_definition','stddev_mv','min_mv','max_mv','snr','cycles','adc_samples','saturated','timing_overrun','calibrated','ntu','extrapolated'];const rows=[fields.join(','),...history.map(r=>fields.map(f=>r[f]??'').join(','))];const blob=new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`turbidimetro-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;a.click();URL.revokeObjectURL(a.href);}
function setStatus(message){$('status').textContent=message;}
