// Versión para INTERNET de sync.js: en vez de la central de la compu del restaurante habla con la base en Supabase.
// Sólo sincroniza los insumos (asadero_insumos_v1). Todo pasa por funciones que piden el PIN de empleados:
// la página nunca lee ni escribe las tablas directo.
// Necesita window.AS_NUBE = {url, key} definido ANTES de cargar este archivo.
(function(){
  var CLAVES = ['asadero_insumos_v1'];
  var N = window.AS_NUBE; if(!N) return;
  var ver = {}, pendiente = {}, enVuelo = {}, aplicando = false, estado = null, ultimo = {};
  var setOriginal = Storage.prototype.setItem;
  var PIN_KEY = 'asadero_pin_nube';

  function pinGuardado(){ try { return localStorage.getItem(PIN_KEY) || ''; } catch(e){ return ''; } }
  function guardarPin(p){ try { if(p) setOriginal.call(localStorage, PIN_KEY, p); else localStorage.removeItem(PIN_KEY); } catch(e){} }
  // Ya no se pregunta con una ventanita: la página muestra su propia pantalla de entrada (candado con PIN).
  function pedirPin(msg){ return ''; }

  function poner(clave, doc){
    aplicando = true; ultimo[clave] = JSON.stringify(doc);
    try { setOriginal.call(localStorage, clave, ultimo[clave]); } catch(e){}
    aplicando = false;
  }
  function avisar(clave){
    try { window.dispatchEvent(new StorageEvent('storage', {key: clave})); }
    catch(e){ var ev = document.createEvent('Event'); ev.initEvent('storage', false, false); ev.key = clave; window.dispatchEvent(ev); }
  }
  function marcar(ok){
    if(estado === ok && document.getElementById('asCentral')) return; estado = ok;
    var e = document.getElementById('asCentral');
    if(!e){
      e = document.createElement('div'); e.id = 'asCentral';
      e.style.cssText = 'position:fixed;left:50%;top:2px;transform:translateX(-50%);z-index:60;font:10px Oswald,system-ui,sans-serif;padding:1px 8px;border-radius:20px;pointer-events:none;white-space:nowrap;opacity:.9';
      (document.body || document.documentElement).appendChild(e);
    }
    e.textContent = ok ? '● Conectado' : '● Sin conexión: se guarda aquí';
    e.style.background = ok ? '#14301b' : '#3a1210'; e.style.color = ok ? '#7bd88f' : '#ff8a80';
  }

  // Llama a una función de la base (asíncrono).
  function rpc(nombre, cuerpo){
    return fetch(N.url + '/rest/v1/rpc/' + nombre, {
      method: 'POST',
      headers: {'apikey': N.key, 'Authorization': 'Bearer ' + N.key, 'Content-Type': 'application/json'},
      body: JSON.stringify(cuerpo)
    }).then(function(r){ if(!r.ok) throw 0; return r.json(); });
  }
  // Igual pero síncrono (sólo al abrir, para que la página lea sus datos ya actualizados).
  function rpcSync(nombre, cuerpo){
    var x = new XMLHttpRequest();
    x.open('POST', N.url + '/rest/v1/rpc/' + nombre, false);
    x.setRequestHeader('apikey', N.key); x.setRequestHeader('Authorization', 'Bearer ' + N.key);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(cuerpo));
    if(x.status !== 200) throw 0;
    return JSON.parse(x.responseText);
  }
  function malPin(r){
    if(r && r.error === 'bloqueado'){ alert('Demasiados intentos con PIN equivocado. Espera 10 minutos e intenta de nuevo.'); return true; }
    if(r && r.error === 'pin'){ guardarPin(''); return true; }
    return false;
  }

  // 1) Al abrir: pide el PIN (si no lo tiene) y trae lo de la nube antes de que la página lea sus datos.
  var pin = pinGuardado();
  CLAVES.forEach(function(clave){
    for(var intento = 0; intento < 3; intento++){
      if(!pin) pin = pedirPin(intento ? 'PIN incorrecto.' : '');
      if(!pin) { estado = false; return; }
      try {
        var r = rpcSync('asadero_get', {p_pin: pin, p_clave: clave});
        if(malPin(r)){ pin = ''; if(r.error === 'bloqueado') return; continue; }
        ver[clave] = r.ver;
        if(r.doc) poner(clave, r.doc);
        else if(localStorage.getItem(clave)) pendiente[clave] = true;
        estado = true; return;
      } catch(e){ estado = false; return; }
    }
  });

  // 2) Cada vez que la página guarda, se manda (juntando los guardados seguidos).
  var tiempos = {};
  Storage.prototype.setItem = function(k, v){
    setOriginal.call(this, k, v);
    if(this === localStorage && !aplicando && CLAVES.indexOf(k) >= 0 && v !== ultimo[k]){
      pendiente[k] = true; clearTimeout(tiempos[k]); tiempos[k] = setTimeout(function(){ mandar(k); }, 250);
    }
  };
  function mandar(clave){
    if(enVuelo[clave]) { tiempos[clave] = setTimeout(function(){ mandar(clave); }, 300); return; }
    var txt = localStorage.getItem(clave); if(!txt){ pendiente[clave] = false; return; }
    var p = pinGuardado(); if(!p){ pendiente[clave] = true; marcar(false); return; }
    enVuelo[clave] = true; pendiente[clave] = false;
    rpc('asadero_set', {p_pin: p, p_clave: clave, p_doc: JSON.parse(txt)})
      .then(function(r){
        enVuelo[clave] = false;
        if(malPin(r)){ pendiente[clave] = true; marcar(false); return; }
        ver[clave] = r.ver; marcar(true);
        if(!pendiente[clave]){ poner(clave, r.doc); avisar(clave); }
      })
      .catch(function(){ enVuelo[clave] = false; pendiente[clave] = true; marcar(false); });
  }

  // 3) Cada 4 segundos pregunta sólo los números de versión y baja los datos de lo que cambió.
  setInterval(function(){
    CLAVES.forEach(function(c){ if(pendiente[c] && !enVuelo[c]) mandar(c); });
    var p = pinGuardado(); if(!p) return;
    rpc('asadero_vers', {p_pin: p}).then(function(vs){
      if(malPin(vs)){ marcar(false); return; }
      marcar(true);
      CLAVES.forEach(function(clave){
        if(pendiente[clave] || enVuelo[clave] || !(vs[clave] > (ver[clave]||0))) return;
        rpc('asadero_get', {p_pin: p, p_clave: clave}).then(function(r){
          if(r.error || pendiente[clave] || enVuelo[clave] || !r.doc || r.ver <= (ver[clave]||0)) return;
          ver[clave] = r.ver; poner(clave, r.doc); avisar(clave);
        }).catch(function(){});
      });
    }).catch(function(){ marcar(false); });
  }, 4000);

  window.addEventListener('load', function(){
    marcar(estado !== false);
    CLAVES.forEach(function(c){ if(pendiente[c]) mandar(c); });
  });
})();
